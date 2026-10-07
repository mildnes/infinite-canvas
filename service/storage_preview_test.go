package service

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestStoragePreviewResizeAndOriginalIsolation(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2048, 1024))
	for y := 400; y < 600; y++ {
		for x := 800; x < 1200; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 255, G: 255, B: 255, A: 255})
		}
	}
	var original bytes.Buffer
	if err := png.Encode(&original, source); err != nil {
		t.Fatal(err)
	}
	before := append([]byte(nil), original.Bytes()...)
	data, err := encodeStoragePreview(original.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	decoded, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if format != "png" || decoded.Bounds().Dx() != 1024 || decoded.Bounds().Dy() != 512 {
		t.Fatalf("preview: %v, %s", decoded.Bounds(), format)
	}
	_, _, _, alpha := decoded.At(0, 0).RGBA()
	r, g, b, contentAlpha := decoded.At(500, 250).RGBA()
	if alpha != 0 || contentAlpha != 65535 || r != 65535 || g != 65535 || b != 65535 {
		t.Fatal("white content or transparent background changed")
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
	var transparent bytes.Buffer
	_ = png.Encode(&transparent, image.NewNRGBA(image.Rect(0, 0, 16, 16)))
	if err := writeStoragePreview("preview-object", transparent.Bytes()); err != nil {
		t.Fatal(err)
	}
	stored, _ := os.ReadFile(ExistingStoragePreviewPath("preview-object"))
	if !bytes.Equal(stored, jpegData.Bytes()) {
		t.Fatal("first preview was overwritten")
	}
	if _, err := os.Stat(StoragePreviewPath("preview-object", "png")); !os.IsNotExist(err) {
		t.Fatal("second format was published")
	}
	if hasGeneratedMediaCopy(model.StorageObject{ID: "preview-object", MimeType: "image/png"}) {
		t.Fatal("preview counted as original copy")
	}
	for _, id := range []string{"../escape", "a/b", "", "a%2Fb"} {
		if StoragePreviewPath(id, "jpeg") != "" || StoragePreviewPath(id, "png") != "" || ExistingStoragePreviewPath(id) != "" {
			t.Fatalf("unsafe ID: %q", id)
		}
	}
}

func TestStoragePreviewAlphaThresholdAndFormats(t *testing.T) {
	for _, alpha := range []uint8{0, 249, 250, 255} {
		source := image.NewNRGBA(image.Rect(0, 0, 128, 64))
		for i := 0; i < len(source.Pix); i += 4 {
			copy(source.Pix[i:i+4], []byte{255, 255, 255, alpha})
		}
		if storagePreviewHasAlpha(source) != (alpha < 250) {
			t.Fatalf("alpha threshold: %d", alpha)
		}
		var original bytes.Buffer
		_ = png.Encode(&original, source)
		preview, err := encodeStoragePreview(original.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		_, format, err := image.DecodeConfig(bytes.NewReader(preview))
		want := "jpeg"
		if alpha < 250 {
			want = "png"
		}
		if err != nil || format != want {
			t.Fatalf("alpha %d: %s, %v", alpha, format, err)
		}
		if alpha >= 250 {
			var old bytes.Buffer
			white := image.NewRGBA(source.Bounds())
			for i := range white.Pix {
				white.Pix[i] = 255
			}
			_ = jpeg.Encode(&old, white, &jpeg.Options{Quality: 80})
			if !bytes.Equal(old.Bytes(), preview) {
				t.Fatal("opaque preview no longer matches JPEG q80")
			}
		}
	}
	gifSource := image.NewPaletted(image.Rect(0, 0, 64, 32), color.Palette{color.Transparent, color.White})
	gifSource.SetColorIndex(32, 16, 1)
	var original bytes.Buffer
	if err := gif.Encode(&original, gifSource, nil); err != nil {
		t.Fatal(err)
	}
	preview, err := encodeStoragePreview(original.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	_, format, _ := image.DecodeConfig(bytes.NewReader(preview))
	if format != "png" {
		t.Fatal("transparent GIF was flattened")
	}
}

func TestStoragePreviewPNGValidationAndLimits(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 1024, 640))
	_, _ = rand.New(rand.NewSource(1)).Read(source.Pix)
	var data bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.NoCompression}
	if err := encoder.Encode(&data, source); err != nil {
		t.Fatal(err)
	}
	if data.Len() <= StoragePreviewMaxBytes || data.Len() > StoragePreviewPNGMaxBytes {
		t.Fatalf("PNG limit fixture: %d", data.Len())
	}
	if err := validateStoragePreview(data.Bytes()); err != nil {
		t.Fatal("valid PNG between 2 and 4 MiB rejected:", err)
	}
	if validateStoragePreview(append(data.Bytes(), make([]byte, StoragePreviewPNGMaxBytes+1-data.Len())...)) == nil {
		t.Fatal("PNG over 4 MiB accepted")
	}
	if validateStoragePreview(data.Bytes()[:data.Len()/2]) == nil {
		t.Fatal("truncated PNG accepted")
	}
	data.Reset()
	_ = png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 1, 1025)))
	if validateStoragePreview(data.Bytes()) == nil {
		t.Fatal("PNG over 1024 accepted")
	}
	data.Reset()
	_ = jpeg.Encode(&data, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	if validateStoragePreview(append(data.Bytes(), make([]byte, StoragePreviewMaxBytes+1-data.Len())...)) == nil {
		t.Fatal("JPEG over 2 MiB accepted")
	}
	data.Reset()
	_ = gif.Encode(&data, image.NewPaletted(image.Rect(0, 0, 8, 8), color.Palette{color.White}), nil)
	if validateStoragePreview(data.Bytes()) == nil {
		t.Fatal("GIF preview accepted")
	}
}

func TestStoragePreviewCrossFormatConcurrentFirstWriteAndRegeneration(t *testing.T) {
	old := config.Cfg
	defer func() { config.Cfg = old }()
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "test.db")
	config.Cfg.StorageDriver = "sqlite"
	var jpg, pngData bytes.Buffer
	_ = jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	_ = png.Encode(&pngData, image.NewNRGBA(image.Rect(0, 0, 8, 8)))
	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			data := jpg.Bytes()
			if i%2 == 0 {
				data = pngData.Bytes()
			}
			if err := writeStoragePreview("race", data); err != nil {
				t.Error(err)
			}
		}(i)
	}
	group.Wait()
	_, jpgErr := os.Stat(StoragePreviewPath("race", "jpeg"))
	_, pngErr := os.Stat(StoragePreviewPath("race", "png"))
	if (jpgErr == nil) == (pngErr == nil) {
		t.Fatal("expected exactly one published format")
	}
	if err := os.Remove(ExistingStoragePreviewPath("race")); err != nil {
		t.Fatal(err)
	}
	if err := writeStoragePreview("race", pngData.Bytes()); err != nil {
		t.Fatal(err)
	}
	if ExistingStoragePreviewPath("race") != StoragePreviewPath("race", "png") {
		t.Fatal("manual cache removal did not allow PNG regeneration")
	}
	if hasGeneratedMediaCopy(model.StorageObject{ID: "race", MimeType: "image/png"}) {
		t.Fatal("PNG preview counted as original copy")
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
