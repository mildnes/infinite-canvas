package service

import (
	"context"
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestGeneratedMediaContentAddressIsUserScoped(t *testing.T) {
	checksum := "0123456789abcdef"
	first := GeneratedMediaObjectID("user-a", checksum)
	if first == "" || first != GeneratedMediaObjectID("user-a", checksum) {
		t.Fatal("same user and checksum must produce one stable object ID")
	}
	if first == GeneratedMediaObjectID("user-b", checksum) {
		t.Fatal("different users must not share a storage object")
	}
}

func TestReadTrustedGeneratedMediaDataURL(t *testing.T) {
	data, decodeErr := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	payload, err := ReadTrustedGeneratedMedia(context.Background(), "data:image/png;base64,"+base64.StdEncoding.EncodeToString(data))
	if err != nil {
		t.Fatal(err)
	}
	if string(payload.Data) != string(data) || payload.MimeType != "image/png" || payload.SHA256 == "" || payload.SourceURL != "" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestReadTrustedGeneratedMediaProxyKeepsSSRFProtection(t *testing.T) {
	source, unwrapErr := UnwrapGeneratedMediaSourceURL("/api/proxy-image?url=https%3A%2F%2Fimages.example%2Fresult.png")
	if unwrapErr != nil || source != "https://images.example/result.png" {
		t.Fatalf("proxy source = %q, %v", source, unwrapErr)
	}
	_, err := ReadTrustedGeneratedMedia(context.Background(), "/api/proxy-image?url=http%3A%2F%2F127.0.0.1%2Fsecret.png")
	if err == nil {
		t.Fatal("proxy-wrapped private address must remain blocked")
	}
}

func TestGeneratedMediaRangeAndPath(t *testing.T) {
	previous := config.Cfg
	defer func() { config.Cfg = previous }()
	root := t.TempDir()
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(root, "canvas.db")
	dir := GeneratedMediaDir()
	if dir != filepath.Join(root, "generated-media") {
		t.Fatalf("media dir = %q", dir)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	object := model.StorageObject{ID: "sample", ObjectKey: "sample.png", MimeType: "image/png"}
	if err := os.WriteFile(filepath.Join(dir, object.ObjectKey), []byte("0123456789"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := downloadGeneratedMedia(object, "bytes=2-4")
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(result.Stream)
	_ = result.Stream.Close()
	if err != nil || result.StatusCode != 206 || result.ContentRange != "bytes 2-4/10" || string(data) != "234" {
		t.Fatalf("partial download: %q, %+v, %v", data, result, err)
	}
	result, err = downloadGeneratedMedia(object, "bytes=20-")
	if err != nil {
		t.Fatal(err)
	}
	_ = result.Stream.Close()
	if result.StatusCode != 416 || result.ContentRange != "bytes */10" {
		t.Fatalf("invalid range: %+v", result)
	}
	object.ObjectKey = "../sample.png"
	if _, err := downloadGeneratedMedia(object, ""); err == nil {
		t.Fatal("escaped media path should be rejected")
	}
}

func TestGeneratedCopyRequiresVerifiedCloudAndGrace(t *testing.T) {
	current := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	object := model.StorageObject{ProviderID: "storage-cloud", CloudSyncedAt: current.Add(-31 * 24 * time.Hour).Format(time.RFC3339Nano)}
	if !generatedCopyReady(object, current, 30*24*time.Hour) {
		t.Fatal("verified old cloud copy should be eligible")
	}
	object.ProviderID = generatedMediaProviderID
	if generatedCopyReady(object, current, 30*24*time.Hour) {
		t.Fatal("local-only object must not be cleaned")
	}
	object.ProviderID = "storage-cloud"
	object.CloudSyncedAt = current.Add(-29 * 24 * time.Hour).Format(time.RFC3339Nano)
	if generatedCopyReady(object, current, 30*24*time.Hour) {
		t.Fatal("fresh cloud copy must remain during grace period")
	}
	object.CloudSyncedAt = current.Add(-31 * 24 * time.Hour).Format(time.RFC3339Nano)
	object.LocalCopyRemovedAt = current.Format(time.RFC3339Nano)
	if generatedCopyReady(object, current, 30*24*time.Hour) {
		t.Fatal("already cleaned object must not be cleaned twice")
	}
}
