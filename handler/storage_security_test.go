package handler

import (
	"bytes"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

type uploadReadCounter struct{ reads int }

func (r *uploadReadCounter) Read(p []byte) (int, error) {
	r.reads++
	return 0, io.EOF
}

func TestUnauthorizedUploadDoesNotReadMultipartBody(t *testing.T) {
	body := &uploadReadCounter{}
	r := httptest.NewRequest("POST", "/api/v1/files", body)
	r.Header.Set("Content-Type", "multipart/form-data; boundary=fixture")
	w := httptest.NewRecorder()
	UploadFile(w, r)
	if body.reads != 0 {
		t.Fatalf("unauthorized upload read body %d times", body.reads)
	}
}

func TestProxyImageRejectsActiveContentBeforeWritingBody(t *testing.T) {
	for _, contentType := range []string{"text/html; charset=utf-8", "image/svg+xml", "application/octet-stream", "image/unknown", "video/mp4", "audio/mpeg"} {
		t.Run(contentType, func(t *testing.T) {
			w := httptest.NewRecorder()
			resp := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {contentType}}, Body: io.NopCloser(strings.NewReader("<unsafe-upstream-body>"))}
			_ = writeProxyImageResponse(w, resp)
			if w.Code < 400 || strings.Contains(w.Body.String(), "<unsafe-upstream-body>") {
				t.Fatalf("unsafe upstream reflected: status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestProxyImageNormalizesMIMEAndOwnsResponsePolicy(t *testing.T) {
	w := httptest.NewRecorder()
	resp := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"Image/PNG; charset=binary"}, "Content-Disposition": {"inline; filename=unsafe.html"}}, Body: io.NopCloser(strings.NewReader("png-bytes"))}
	if err := writeProxyImageResponse(w, resp); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Content-Disposition") != "" || w.Body.String() != "png-bytes" {
		t.Fatalf("proxy response policy: status=%d headers=%v body=%s", w.Code, w.Header(), w.Body.String())
	}
}

func TestProxyMediaPreservesVideoAndAudioStreaming(t *testing.T) {
	for _, contentType := range []string{"Video/MP4; charset=binary", "audio/mpeg", "video/webm", "audio/ogg"} {
		t.Run(contentType, func(t *testing.T) {
			w := httptest.NewRecorder()
			body := strings.Repeat("media-bytes", 4096)
			resp := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {contentType}, "Content-Disposition": {"inline; filename=unsafe.html"}}, Body: io.NopCloser(strings.NewReader(body))}
			if err := writeProxyMediaResponse(w, resp, false); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || w.Header().Get("Content-Type") != service.NormalizeStorageMIME(contentType) || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Content-Disposition") != "" || w.Body.String() != body || !w.Flushed {
				t.Fatalf("media streaming rejected or changed: status=%d headers=%v bytes=%d flushed=%v", w.Code, w.Header(), w.Body.Len(), w.Flushed)
			}
		})
	}
}

func TestProxyMediaRejectsActiveAndUnknownContent(t *testing.T) {
	for _, contentType := range []string{"text/html; charset=utf-8", "image/svg+xml", "application/octet-stream", "video/unknown", "audio/unknown"} {
		t.Run(contentType, func(t *testing.T) {
			w := httptest.NewRecorder()
			resp := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {contentType}}, Body: io.NopCloser(strings.NewReader("<unsafe-upstream-body>"))}
			_ = writeProxyMediaResponse(w, resp, false)
			if w.Code < 400 || strings.Contains(w.Body.String(), "<unsafe-upstream-body>") || w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("unsafe media upstream reflected: status=%d body=%s", w.Code, w.Body)
			}
		})
	}
}

func TestProxyMediaPreservesSourceAuthorizationAndSSRF(t *testing.T) {
	previousHosts := config.Cfg.ImageProxyAllowedHosts
	t.Cleanup(func() { config.Cfg.ImageProxyAllowedHosts = previousHosts })
	for _, handle := range []http.HandlerFunc{ProxyImage, ProxyMedia} {
		config.Cfg.ImageProxyAllowedHosts = "allowed.example"
		w := httptest.NewRecorder()
		handle(w, httptest.NewRequest("GET", "/proxy?url=https://denied.example/media", nil))
		if w.Code != http.StatusForbidden {
			t.Fatalf("proxy skipped source authorization: status=%d body=%s", w.Code, w.Body)
		}
		config.Cfg.ImageProxyAllowedHosts = ""
		w = httptest.NewRecorder()
		handle(w, httptest.NewRequest("GET", "/proxy?url=http://127.0.0.1/private", nil))
		if w.Code != http.StatusBadGateway {
			t.Fatalf("proxy skipped SSRF protection: status=%d body=%s", w.Code, w.Body)
		}
	}
}

func TestStorageHTTPReadBoundaries(t *testing.T) {
	if os.Getenv("IC_STORAGE_HTTP_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestStorageHTTPReadBoundaries$", "-test.v")
		command.Env = append(os.Environ(), "IC_STORAGE_HTTP_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("storage HTTP fixture: %v\n%s", err, output)
		}
		return
	}
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "http.db")
	if _, err := repository.DB(); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(service.GeneratedMediaDir(), 0700); err != nil {
		t.Fatal(err)
	}
	var pngData bytes.Buffer
	_ = png.Encode(&pngData, image.NewNRGBA(image.Rect(0, 0, 2, 2)))
	for _, sample := range []struct {
		id, mime, data string
	}{
		{"png", "image/png", pngData.String()},
		{"html", "text/html", "<html>unsafe</html>"},
		{"svg", "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"},
		{"disguised", "image/png", "<html>disguised</html>"},
	} {
		object := model.StorageObject{ID: sample.id, ObjectKey: sample.id + ".original", MimeType: sample.mime, Bytes: int64(len(sample.data)), ProviderID: "local-generated", CreatedBy: "owner"}
		_, _ = repository.SaveStorageObject(object)
		if err := os.WriteFile(filepath.Join(service.GeneratedMediaDir(), object.ObjectKey), []byte(sample.data), 0600); err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		FileContent(w, httptest.NewRequest("GET", "/content", nil), object.ID)
		if w.Code != 200 || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Body.String() != sample.data {
			t.Errorf("content changed: %s %d %v", sample.id, w.Code, w.Header())
		}
		if sample.id != "png" && (w.Header().Get("Content-Type") != "application/octet-stream" || w.Header().Get("Content-Disposition") != "attachment") {
			t.Errorf("legacy active content not downgraded: %s %v", sample.id, w.Header())
		}
	}
	_, _ = repository.SaveStorageObject(model.StorageObject{ID: "deleted", ObjectKey: "deleted", DeletedAt: "deleted"})
	for _, read := range []func(http.ResponseWriter, *http.Request, string){FileInfo, FileContent} {
		for _, id := range []string{"deleted", "missing"} {
			w := httptest.NewRecorder()
			read(w, httptest.NewRequest("GET", "/file", nil), id)
			if w.Code != 404 {
				t.Errorf("deleted/missing object returned %d", w.Code)
			}
		}
	}
}
