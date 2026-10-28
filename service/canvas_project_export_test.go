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
	"net/url"
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

func TestCanvasProjectExportLocalMedia(t *testing.T) {
	const childEnv = "IC_CANVAS_EXPORT_LOCAL_MEDIA_TEST"
	if os.Getenv(childEnv) != t.Name() {
		command := exec.Command(os.Args[0], "-test.run=^"+t.Name()+"$", "-test.v")
		command.Env = append(os.Environ(), childEnv+"="+t.Name())
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated local media export fixture: %v\n%s", err, output)
		}
		t.Logf("%s", output)
		return
	}
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "canvas-export-local-media.db")
	config.Cfg.JWTSecret = "canvas-export-local-media-secret"
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	ctx := WithUser(context.Background(), model.AuthUser{ID: "local-media-owner"})
	saveProject := func(t *testing.T, id string, fields map[string]any) json.RawMessage {
		t.Helper()
		fields["id"] = id
		raw, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		project := model.CanvasProject{
			UserID: "local-media-owner", ID: id, ProjectData: string(raw),
			CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-02T00:00:00Z",
		}
		if err := database.Create(&project).Error; err != nil {
			t.Fatal(err)
		}
		return raw
	}
	localNode := func(key string) any {
		return map[string]any{"metadata": map[string]any{"storageKey": key}}
	}
	cases := []struct {
		name   string
		fields map[string]any
		count  int
	}{
		{
			name: "synced board with local image audio and video",
			fields: map[string]any{"nodes": []any{
				localNode("image:local-image"), localNode("audio:local-audio"), localNode("video:local-video"),
			}},
			count: 3,
		},
		{
			name: "nested batch nodes",
			fields: map[string]any{"nodes": []any{map[string]any{
				"metadata": map[string]any{"storageKey": "image:batch-root", "isBatchRoot": true},
				"batch":    []any{localNode("video:batch-child"), localNode("audio:batch-child")},
			}}},
			count: 3,
		},
		{
			name: "chat-only references and assistant images",
			fields: map[string]any{"nodes": []any{}, "chatSessions": []any{map[string]any{
				"messages": []any{map[string]any{
					"references": []any{map[string]any{"storageKey": "audio:chat-reference"}},
					"images":     []any{map[string]any{"storageKey": "image:assistant-result"}},
				}},
			}}},
			count: 2,
		},
		{
			name: "mixed cloud and local media",
			fields: map[string]any{"nodes": []any{
				localNode("server:cloud-object"), localNode("image:local-image"),
			}},
			count: 1,
		},
		{
			name: "duplicates across nodes batches and chats",
			fields: map[string]any{
				"nodes": []any{localNode("image:shared"), map[string]any{
					"batch": []any{localNode("image:shared"), localNode("audio:shared")},
				}},
				"chatSessions": []any{map[string]any{"messages": []any{map[string]any{
					"references": []any{map[string]any{"storageKey": "image:shared"}, map[string]any{"storageKey": "audio:shared"}},
				}}}},
			},
			count: 2,
		},
		{
			name: "prefixes produced by local media stores",
			fields: map[string]any{"nodes": []any{
				localNode("image:image"), localNode("video:video"), localNode("audio:audio"), localNode("media:media"),
				localNode("file:file"), localNode("asset-media:asset"), localNode("asset-video:asset"),
				localNode("asset-audio:asset"), localNode("workflow-video:workflow"), localNode("workflow-audio:workflow"),
				localNode("generated-video:generated"), localNode("video-reference:reference"), localNode("audio-reference:reference"),
			}},
			count: 13,
		},
		{
			name: "ordinary text fields are not media references",
			fields: map[string]any{
				"title": "image:title",
				"nodes": []any{map[string]any{
					"metadata": map[string]any{"content": "image:plain-text", "prompt": "video:plain-text"},
				}},
				"chatSessions": []any{map[string]any{"messages": []any{map[string]any{"text": "audio:plain-text"}}}},
			},
		},
		{
			name: "unknown storageKey prefixes follow the browser exporter",
			fields: map[string]any{"nodes": []any{
				localNode("custom:unsupported"), localNode("image:"), localNode("https://example.com/image.png"),
			}},
			count: 3,
		},
		{
			name:   "pure cloud board keeps server ticket",
			fields: map[string]any{"nodes": []any{localNode("server:cloud-only")}},
		},
	}
	for index, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			id := fmt.Sprintf("local-media-%d", index)
			saveProject(t, id, test.fields)
			canvasExportTickets.Lock()
			before := len(canvasExportTickets.pending)
			canvasExportTickets.Unlock()
			result, err := CreateCanvasProjectExportTicket(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			canvasExportTickets.Lock()
			after := len(canvasExportTickets.pending)
			canvasExportTickets.Unlock()
			encoded, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			var response struct {
				Mode            string    `json:"mode"`
				URL             string    `json:"url"`
				ExpiresAt       time.Time `json:"expiresAt"`
				LocalAssetCount int       `json:"localAssetCount"`
			}
			if err := json.Unmarshal(encoded, &response); err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &fields); err != nil {
				t.Fatal(err)
			}
			if test.count > 0 {
				if response.Mode != "browser" || response.LocalAssetCount != test.count ||
					len(fields) != 2 || !response.ExpiresAt.IsZero() || before != after {
					t.Fatalf("local assets must choose browser without a ticket: response=%s pending before=%d after=%d wantCount=%d",
						encoded, before, after, test.count)
				}
				return
			}
			if response.Mode != "server" || response.URL == "" || response.ExpiresAt.IsZero() ||
				len(fields) != 3 || response.LocalAssetCount != 0 || after != before+1 {
				t.Fatalf("cloud-only export must retain server ticket: response=%s pending before=%d after=%d", encoded, before, after)
			}
		})
	}
	t.Run("local media introduced after ticket issuance is reported in missing json", func(t *testing.T) {
		const id = "local-media-after-ticket"
		saveProject(t, id, map[string]any{"nodes": []any{}, "chatSessions": []any{}})
		result, err := CreateCanvasProjectExportTicket(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		link, err := url.Parse(result.URL)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(map[string]any{
			"id": id,
			"nodes": []any{
				localNode("image:late-image"), localNode("image:late-image"),
				localNode("video:late-video"), localNode("audio:late-audio"),
			},
			"chatSessions": []any{map[string]any{"messages": []any{map[string]any{
				"references": []any{map[string]any{"storageKey": "media:late-chat"}, map[string]any{"storageKey": "image:late-image"}},
			}}}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := database.Model(&model.CanvasProject{}).Where("user_id = ? AND id = ?", "local-media-owner", id).
			Update("project_data", string(raw)).Error; err != nil {
			t.Fatal(err)
		}
		export, err := OpenCanvasProjectExport(context.Background(), id, link.Query().Get("ticket"))
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		if err := export.Write(context.Background(), &out); err != nil {
			t.Fatal(err)
		}
		archive, err := zip.NewReader(bytes.NewReader(out.Bytes()), int64(out.Len()))
		if err != nil {
			t.Fatal(err)
		}
		var missing []canvasExportMissing
		for _, file := range archive.File {
			if file.Name != "missing.json" {
				continue
			}
			reader, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			err = json.NewDecoder(reader).Decode(&missing)
			_ = reader.Close()
			if err != nil {
				t.Fatal(err)
			}
		}
		want := map[string]bool{"image:late-image": true, "audio:late-audio": true, "video:late-video": true, "media:late-chat": true}
		if len(missing) != len(want) {
			t.Fatalf("missing.json reports %d local assets, want %d: %+v", len(missing), len(want), missing)
		}
		for _, asset := range missing {
			if !want[asset.StorageKey] || !strings.Contains(asset.Reason, "浏览器") {
				t.Errorf("unexpected local missing entry: %+v", asset)
			}
			delete(want, asset.StorageKey)
		}
		if len(want) != 0 {
			t.Errorf("missing.json omitted local keys: %v", want)
		}
	})
}

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
