package service

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type canvasExportBlockingStream struct {
	started chan struct{}
	closed  chan struct{}
	reading sync.Once
	closing sync.Once
}

func (stream *canvasExportBlockingStream) Read([]byte) (int, error) {
	stream.reading.Do(func() { close(stream.started) })
	<-stream.closed
	return 0, io.ErrClosedPipe
}

func (stream *canvasExportBlockingStream) Close() error {
	stream.closing.Do(func() { close(stream.closed) })
	return nil
}

type canvasExportCountingWriter struct {
	bytes int64
	fail  error
}

func (writer *canvasExportCountingWriter) Write(data []byte) (int, error) {
	if writer.fail != nil {
		return 0, writer.fail
	}
	writer.bytes += int64(len(data))
	return len(data), nil
}

type canvasExportGeneratedStream struct {
	remaining int64
	read      int64
	maxRead   int
	before    int64
	out       *canvasExportCountingWriter
	streamed  bool
	closed    bool
}

func (stream *canvasExportGeneratedStream) Read(data []byte) (int, error) {
	if stream.remaining == 0 {
		return 0, io.EOF
	}
	if len(data) > stream.maxRead {
		stream.maxRead = len(data)
	}
	n := min(int64(len(data)), stream.remaining)
	clear(data[:n])
	stream.remaining -= n
	stream.read += n
	if stream.read >= 1<<20 && stream.out.bytes-stream.before >= 512<<10 {
		stream.streamed = true
	}
	return int(n), nil
}

func (stream *canvasExportGeneratedStream) Close() error {
	stream.closed = true
	return nil
}

type canvasExportErrorReader struct{ err error }

func (reader canvasExportErrorReader) Read([]byte) (int, error) { return 0, reader.err }

func TestCanvasProjectExportStreaming(t *testing.T) {
	const childEnv = "IC_CANVAS_EXPORT_STREAMING_TEST"
	if os.Getenv(childEnv) != t.Name() {
		command := exec.Command(os.Args[0], "-test.run=^"+t.Name()+"$", "-test.v")
		command.Env = append(os.Environ(), childEnv+"="+t.Name())
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated export streaming fixture: %v\n%s", err, output)
		}
		t.Logf("%s", output)
		return
	}
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "canvas-export-streaming.db")
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	sequence := 0
	fixture := func(t *testing.T, sizes ...int64) (*CanvasProjectExport, []model.StorageObject) {
		t.Helper()
		sequence++
		export := &CanvasProjectExport{
			Title: "合成流式画板", userID: "stream-owner",
			project: json.RawMessage(`{"id":"stream-board","title":"合成流式画板","nodes":[],"connections":[],"chatSessions":[]}`),
			files:   []canvasExportAsset{},
		}
		objects := make([]model.StorageObject, len(sizes))
		for index, size := range sizes {
			id := fmt.Sprintf("stream-%d-%d", sequence, index)
			objects[index] = model.StorageObject{
				ID: id, ObjectKey: id + ".bin", CreatedBy: export.userID,
				Bytes: size, MimeType: "application/octet-stream",
			}
			if err := database.Create(&objects[index]).Error; err != nil {
				t.Fatal(err)
			}
			export.files = append(export.files, canvasExportAsset{
				StorageKey: "server:" + id, Path: "projects/stream-board/files/" + id + ".bin",
				MimeType: objects[index].MimeType, Bytes: size,
			})
		}
		return export, objects
	}

	t.Run("cancel closes active stream and never opens following object", func(t *testing.T) {
		export, objects := fixture(t, 1024, 1024)
		stream := &canvasExportBlockingStream{started: make(chan struct{}), closed: make(chan struct{})}
		var calls atomic.Int32
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		result := make(chan error, 1)
		go func() {
			result <- export.write(ctx, io.Discard, func(context.Context, string, string) (DownloadedStorageObject, error) {
				calls.Add(1)
				return DownloadedStorageObject{Object: objects[0], Stream: stream}, nil
			})
		}()
		select {
		case <-stream.started:
		case <-time.After(time.Second):
			t.Fatal("export did not start reading the first object")
		}
		cancel()
		select {
		case err := <-result:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled export error=%v, want context.Canceled", err)
			}
		case <-time.After(time.Second):
			t.Fatal("cancelled export did not stop within one second")
		}
		select {
		case <-stream.closed:
		default:
			t.Fatal("cancellation did not close the active stream")
		}
		if calls.Load() != 1 {
			t.Fatalf("cancelled export opened %d objects, want only the active first object", calls.Load())
		}
	})
	t.Run("downstream failure stops before any following source download", func(t *testing.T) {
		export, objects := fixture(t, 1<<20, 1024)
		failure := errors.New("client disconnected")
		out := &canvasExportCountingWriter{}
		stream := &canvasExportGeneratedStream{remaining: 1 << 20, out: out}
		calls := 0
		err := export.write(context.Background(), out, func(context.Context, string, string) (DownloadedStorageObject, error) {
			calls++
			out.fail = failure
			return DownloadedStorageObject{Object: objects[0], Stream: stream}, nil
		})
		if !errors.Is(err, failure) || calls != 1 || !stream.closed {
			t.Fatalf("downstream failure: err=%v downloads=%d streamClosed=%v", err, calls, stream.closed)
		}
	})
	t.Run("source read failure and short read are reported while later objects complete", func(t *testing.T) {
		content := []byte("complete final object")
		export, objects := fixture(t, 128, 128, int64(len(content)))
		failure := errors.New("source connection reset")
		calls := 0
		var out bytes.Buffer
		err := export.write(context.Background(), &out, func(_ context.Context, id, _ string) (DownloadedStorageObject, error) {
			index := calls
			calls++
			if id != objects[index].ID {
				t.Errorf("download order=%s, want %s", id, objects[index].ID)
			}
			readers := []io.Reader{
				io.MultiReader(strings.NewReader("partial"), canvasExportErrorReader{failure}),
				strings.NewReader("too short"),
				bytes.NewReader(content),
			}
			return DownloadedStorageObject{Object: objects[index], Stream: io.NopCloser(readers[index])}, nil
		})
		if err != nil || calls != 3 {
			t.Fatalf("source failure stopped the whole archive: err=%v downloads=%d", err, calls)
		}
		archive, err := zip.NewReader(bytes.NewReader(out.Bytes()), int64(out.Len()))
		if err != nil {
			t.Fatal(err)
		}
		files := make(map[string][]byte, len(archive.File))
		for _, file := range archive.File {
			reader, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(reader)
			_ = reader.Close()
			if err != nil {
				t.Fatal(err)
			}
			files[file.Name] = data
		}
		var missing []canvasExportMissing
		if err := json.Unmarshal(files["missing.json"], &missing); err != nil {
			t.Fatal(err)
		}
		if len(missing) != 2 || missing[0].StorageKey != export.files[0].StorageKey ||
			missing[1].StorageKey != export.files[1].StorageKey || missing[0].Reason == "" || missing[1].Reason == "" {
			t.Fatalf("incomplete sources not reported: %+v", missing)
		}
		if !bytes.Equal(files[export.files[2].Path], content) {
			t.Fatal("object after failed sources was not exported intact")
		}
	})
	t.Run("expired context aborts without downloading or writing", func(t *testing.T) {
		export, _ := fixture(t, 1024)
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
		defer cancel()
		calls := 0
		out := &canvasExportCountingWriter{}
		err := export.write(ctx, out, func(context.Context, string, string) (DownloadedStorageObject, error) {
			calls++
			return DownloadedStorageObject{}, errors.New("must not download")
		})
		if !errors.Is(err, context.DeadlineExceeded) || calls != 0 || out.bytes != 0 {
			t.Fatalf("expired export: err=%v downloads=%d written=%d", err, calls, out.bytes)
		}
	})
	for _, source := range []string{"public URL", "WebDAV"} {
		t.Run(source+" request receives export cancellation", func(t *testing.T) {
			export, objects := fixture(t, 1024, 1024)
			started, cancelled := make(chan struct{}), make(chan struct{})
			var starts, cancels sync.Once
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if !strings.Contains(r.URL.Path, objects[0].ID) {
					t.Errorf("opened following object after cancellation: %s", r.URL.Path)
					http.Error(w, "unexpected object", http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Length", "1024")
				w.WriteHeader(http.StatusOK)
				_, _ = io.WriteString(w, "partial")
				w.(http.Flusher).Flush()
				starts.Do(func() { close(started) })
				<-r.Context().Done()
				cancels.Do(func() { close(cancelled) })
			}))
			t.Cleanup(server.Close)
			settings := model.Settings{}
			if source == "WebDAV" {
				settings.Private.Storage.Providers = []model.StorageProvider{{
					ID: "export-webdav", Type: model.StorageProviderTypeWebDAV,
					Endpoint: server.URL, Username: "export-user", Password: "export-password",
					Enabled: true, AllowPrivateNetwork: true,
				}}
			} else {
				client := SafeProxyHTTPClient()
				previous := client.Transport
				transport := http.DefaultTransport.(*http.Transport).Clone()
				transport.Proxy = nil
				client.Transport = transport
				defer func() { client.Transport = previous; transport.CloseIdleConnections() }()
			}
			if _, err := repository.SaveSettings(settings, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
				t.Fatal(err)
			}
			for _, object := range objects {
				changes := map[string]any{"public_url": server.URL + "/" + object.ID}
				if source == "WebDAV" {
					changes["provider_id"] = "export-webdav"
				}
				if err := database.Model(&model.StorageObject{}).Where("id = ?", object.ID).Updates(changes).Error; err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() { result <- export.Write(ctx, io.Discard) }()
			select {
			case <-started:
			case err := <-result:
				t.Fatalf("export stopped before opening %s: %v", source, err)
			case <-time.After(time.Second):
				t.Fatalf("export did not open the %s source", source)
			}
			cancel()
			select {
			case err := <-result:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancelled %s export error=%v", source, err)
				}
			case <-time.After(time.Second):
				t.Fatalf("%s export did not stop after cancellation", source)
			}
			select {
			case <-cancelled:
			case <-time.After(time.Second):
				t.Fatalf("%s HTTP request did not receive cancellation", source)
			}
			if calls.Load() != 1 {
				t.Fatalf("%s source requests=%d, want only first object", source, calls.Load())
			}
		})
	}
	t.Run("178 generated eight MiB objects stream with bounded allocation", func(t *testing.T) {
		const count = 178
		const objectBytes = 8 << 20
		sizes := make([]int64, count)
		for index := range sizes {
			sizes[index] = objectBytes
		}
		export, objects := fixture(t, sizes...)
		out := &canvasExportCountingWriter{}
		streams := make([]*canvasExportGeneratedStream, 0, count)
		var before, after runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&before)
		err := export.write(context.Background(), out, func(_ context.Context, id, _ string) (DownloadedStorageObject, error) {
			index := len(streams)
			if id != objects[index].ID {
				t.Errorf("download order=%s, want %s", id, objects[index].ID)
			}
			stream := &canvasExportGeneratedStream{remaining: objectBytes, before: out.bytes, out: out}
			streams = append(streams, stream)
			return DownloadedStorageObject{Object: objects[index], Stream: stream}, nil
		})
		runtime.ReadMemStats(&after)
		if err != nil || len(streams) != count {
			t.Fatalf("generated stream export: err=%v downloads=%d", err, len(streams))
		}
		maxRead := 0
		for index, stream := range streams {
			if !stream.closed || !stream.streamed || stream.remaining != 0 {
				t.Fatalf("source %d was buffered or incompletely consumed: %+v", index, stream)
			}
			maxRead = max(maxRead, stream.maxRead)
		}
		payloadBytes := int64(count) * objectBytes
		allocated := after.TotalAlloc - before.TotalAlloc
		if maxRead > 64<<10 || allocated >= 64<<20 || out.bytes < payloadBytes || out.bytes-payloadBytes > 1<<20 {
			t.Fatalf("unbounded streaming: payload=%d written=%d allocated=%d maxRead=%d", payloadBytes, out.bytes, allocated, maxRead)
		}
		t.Logf("SYNTHETIC STREAM ONLY: objects=%d payload_bytes=%d ZIP_bytes=%d total_alloc_bytes=%d max_read_bytes=%d; sources generated on demand, output discarded; production container RSS not measured",
			count, payloadBytes, out.bytes, allocated, maxRead)
	})
}
