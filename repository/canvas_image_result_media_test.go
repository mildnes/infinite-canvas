package repository

import (
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestCanvasImageArchiveDropsNonDurableURLsAndKeepsAllStableImages(t *testing.T) {
	database := resultDB(t)
	task := resultTask("multiple")
	task.ImageStorage = []*model.CanvasImageStorage{
		{URL: "/api/files/object/content", StorageKey: "server:object"},
		{URL: "/api/files/second/content", StorageKey: "server:second"},
		{URL: "data:image/png;base64,AAAA", StorageKey: ""},
		{URL: "https://expiring.example/result", StorageKey: ""},
	}
	task.ImageURLs = []string{"data:image/png;base64,SHOULD-NOT-BE-KEPT"}
	if err := database.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	bad := resultTask("temporary")
	bad.ImageURL = "https://expiring.example/result"
	bad.StorageKey = ""
	if err := database.Create(&bad).Error; err != nil {
		t.Fatal(err)
	}
	if err := DeleteFinishedCanvasImageTasksBefore(time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	got, found, err := GetUserCanvasImageTask("owner", task.ID)
	if err != nil || !found || len(got.ImageURLs) != 2 || len(got.ImageStorage) != 2 || got.ImageURLs[1] != "/api/files/second/content" {
		t.Fatalf("stable image list: %+v %v %v", got, found, err)
	}
	if _, found, err := GetUserCanvasImageTask("owner", bad.ID); err != nil || found {
		t.Fatal("temporary upstream link became durable result")
	}
}
