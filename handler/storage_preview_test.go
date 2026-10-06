package handler

import (
	"bytes"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/service"
)

func TestFilePreviewMissingIsRealNonCached404(t *testing.T) {
	w := httptest.NewRecorder()
	serveFilePreview(w, httptest.NewRequest(http.MethodGet, "/api/files/missing/preview", nil), nil, os.ErrNotExist)
	if w.Code != http.StatusNotFound || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status/cache: %d, %s", w.Code, w.Header().Get("Cache-Control"))
	}
}

func TestFilePreviewJPEGCacheHEADAndRange(t *testing.T) {
	var data bytes.Buffer
	if err := jpeg.Encode(&data, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(t.TempDir(), "preview.jpg")
	if err := os.WriteFile(name, data.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		file, err := os.Open(name)
		if err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		serveFilePreview(w, httptest.NewRequest(method, "/preview", nil), file, nil)
		if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "image/jpeg" || !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
			t.Fatalf("invalid response: %d %+v", w.Code, w.Header())
		}
		if method == http.MethodGet && !bytes.Equal(w.Body.Bytes(), data.Bytes()) {
			t.Fatal("preview bytes changed")
		}
		if method == http.MethodHead && w.Body.Len() != 0 {
			t.Fatal("HEAD included body")
		}
	}
	file, err := os.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "/preview", nil)
	r.Header.Set("Range", "bytes=0-9")
	w := httptest.NewRecorder()
	serveFilePreview(w, r, file, nil)
	if w.Code != http.StatusPartialContent || !bytes.Equal(w.Body.Bytes(), data.Bytes()[:10]) {
		t.Fatal("preview range response")
	}
}

func TestPutFilePreviewOversizeRejectedBeforeObjectRead(t *testing.T) {
	r := httptest.NewRequest(http.MethodPut, "/preview", strings.NewReader(strings.Repeat("x", service.StoragePreviewMaxBytes+1)))
	w := httptest.NewRecorder()
	PutFilePreview(w, r, "object")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("oversize: %d", w.Code)
	}
}
