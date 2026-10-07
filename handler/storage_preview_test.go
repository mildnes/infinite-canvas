package handler

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
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
		if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "image/jpeg" || w.Header().Get("Cache-Control") != "public, max-age=300, must-revalidate" || w.Header().Get("ETag") == "" {
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
	r := httptest.NewRequest(http.MethodPut, "/preview", strings.NewReader(strings.Repeat("x", service.StoragePreviewPNGMaxBytes+1)))
	w := httptest.NewRecorder()
	PutFilePreview(w, r, "object")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("oversize: %d", w.Code)
	}
}

func TestFilePreviewPNGAndContentETagChangesAfterRegeneration(t *testing.T) {
	dir := t.TempDir()
	var first, second bytes.Buffer
	_ = jpeg.Encode(&first, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	_ = png.Encode(&second, image.NewNRGBA(image.Rect(0, 0, 8, 8)))
	jpgName, pngName := filepath.Join(dir, "preview.jpg"), filepath.Join(dir, "preview.png")
	if err := os.WriteFile(jpgName, first.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	serve := func(name, method, etag string) *httptest.ResponseRecorder {
		t.Helper()
		file, err := os.Open(name)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, "/api/files/object/preview?v=2", nil)
		if etag != "" {
			r.Header.Set("If-None-Match", etag)
		}
		w := httptest.NewRecorder()
		serveFilePreview(w, r, file, nil)
		return w
	}
	before := serve(jpgName, http.MethodGet, "")
	etag := before.Header().Get("ETag")
	if etag == "" || strings.HasPrefix(etag, "W/") || serve(jpgName, http.MethodGet, etag).Code != http.StatusNotModified {
		t.Fatal("unchanged preview did not return strong ETag/304")
	}
	if err := os.Remove(jpgName); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pngName, second.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		after := serve(pngName, method, etag)
		if after.Code != http.StatusOK || after.Header().Get("Content-Type") != "image/png" || after.Header().Get("ETag") == etag || after.Header().Get("Cache-Control") != "public, max-age=300, must-revalidate" {
			t.Fatalf("regenerated PNG reused old cache: %d, %+v", after.Code, after.Header())
		}
		if method == http.MethodGet && !bytes.Equal(after.Body.Bytes(), second.Bytes()) {
			t.Fatal("PNG response bytes changed")
		}
		if method == http.MethodHead && after.Body.Len() != 0 {
			t.Fatal("PNG HEAD included body")
		}
		if serve(pngName, method, after.Header().Get("ETag")).Code != http.StatusNotModified {
			t.Fatal("new PNG conditional request did not return 304")
		}
	}
}
