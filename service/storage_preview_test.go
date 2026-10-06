package service

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestStoragePreviewResizeAndOriginalIsolation(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2048, 1024))
	source.SetNRGBA(1024, 512, color.NRGBA{R: 255, A: 255})
	var original bytes.Buffer
	if err := png.Encode(&original, source); err != nil {
		t.Fatal(err)
	}
	before := append([]byte(nil), original.Bytes()...)
	data, err := encodeStoragePreview(original.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil || decoded.Bounds().Dx() != 1024 || decoded.Bounds().Dy() != 512 {
		t.Fatalf("preview: %v, %v", decoded, err)
	}
	r, g, b, _ := decoded.At(0, 0).RGBA()
	if r < 64000 || g < 64000 || b < 64000 {
		t.Fatal("transparent preview must have white backdrop")
	}
	if !bytes.Equal(before, original.Bytes()) {
		t.Fatal("original mutated")
	}
}

func TestStoragePreviewValidationAndFirstWriteWins(t *testing.T) {
	old := config.Cfg
	defer func() { config.Cfg = old }()
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "test.db")
	config.Cfg.StorageDriver = "sqlite"
	var jpegData bytes.Buffer
	_ = jpeg.Encode(&jpegData, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	if err := writeStoragePreview("preview-object", jpegData.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := writeStoragePreview("preview-object", []byte("invalid")); err == nil {
		t.Fatal("invalid JPEG accepted")
	}
	var second bytes.Buffer
	_ = jpeg.Encode(&second, image.NewRGBA(image.Rect(0, 0, 16, 16)), nil)
	if err := writeStoragePreview("preview-object", second.Bytes()); err != nil {
		t.Fatal(err)
	}
	stored, _ := os.ReadFile(StoragePreviewPath("preview-object"))
	if !bytes.Equal(stored, jpegData.Bytes()) {
		t.Fatal("immutable preview was overwritten")
	}
	if hasGeneratedMediaCopy(model.StorageObject{ID: "preview-object", MimeType: "image/png"}) {
		t.Fatal("preview counted as original copy")
	}
	for _, id := range []string{"../escape", "a/b", "", "a%2Fb"} {
		if StoragePreviewPath(id) != "" {
			t.Fatalf("unsafe ID: %q", id)
		}
	}
}

func TestStoragePreviewOwnerAndDeletedGuard(t *testing.T) {
	object := model.StorageObject{ID: "a", CreatedBy: "owner", MimeType: "image/png"}
	if !canWriteStoragePreview(object, "owner") || canWriteStoragePreview(object, "other") || canWriteStoragePreview(object, "") {
		t.Fatal("owner guard")
	}
	object.DeletedAt = "deleted"
	if canWriteStoragePreview(object, "owner") {
		t.Fatal("deleted object accepted")
	}
}

func TestStoragePreviewRejectsOversizeDimensionsAndTruncatedJPEG(t *testing.T) {
	var data bytes.Buffer
	if err := jpeg.Encode(&data, image.NewRGBA(image.Rect(0, 0, 1025, 1)), nil); err != nil {
		t.Fatal(err)
	}
	if validateStoragePreview(data.Bytes()) == nil {
		t.Fatal("oversize dimensions accepted")
	}
	data.Reset()
	if err := jpeg.Encode(&data, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil); err != nil {
		t.Fatal(err)
	}
	if validateStoragePreview(data.Bytes()[:len(data.Bytes())/2]) == nil {
		t.Fatal("truncated JPEG accepted")
	}
	if validateStoragePreview(make([]byte, StoragePreviewMaxBytes+1)) == nil {
		t.Fatal("oversize bytes accepted")
	}
}
