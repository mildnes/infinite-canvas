package service

import (
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

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
