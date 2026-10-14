package repository

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestWorkbenchTaskRetentionKeepsWorkbenchSources(t *testing.T) {
	previousConfig := config.Cfg
	previousDB, previousErr, previousOnce := db, dbErr, dbOnce
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "workbench-retention.db")
	db, dbErr, dbOnce = nil, nil, sync.Once{}
	t.Cleanup(func() {
		if db != nil {
			if conn, err := db.DB(); err == nil {
				_ = conn.Close()
			}
		}
		config.Cfg = previousConfig
		db, dbErr, dbOnce = previousDB, previousErr, previousOnce
	})

	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	before := time.Now().UTC().Add(-11 * time.Minute).Format(time.RFC3339Nano)
	imageTasks := []model.CanvasImageTask{
		{ID: "image-workbench", UserID: "owner", Source: "image-workbench", Status: "completed", CompletedAt: before},
		{ID: "image-workflow", UserID: "owner", Source: "workflow", Status: "failed", CompletedAt: before},
		{ID: "image-canvas", UserID: "owner", Source: "canvas", Status: "cancelled", CompletedAt: before},
		{ID: "image-active", UserID: "owner", Source: "image-workbench", Status: "processing", CompletedAt: before},
	}
	videoTasks := []model.VideoTask{
		{ID: "video-workbench", UserID: "owner", Source: "video-workbench", Status: "completed", CompletedAt: before},
		{ID: "video-canvas", UserID: "owner", Source: "canvas", Status: "cancelled", CompletedAt: before},
		{ID: "video-active", UserID: "owner", Source: "video-workbench", Status: "running", CompletedAt: before},
	}
	for _, task := range imageTasks {
		if err := database.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, task := range videoTasks {
		if err := database.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}

	if err := DeleteFinishedCanvasImageTasksBefore(time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	if err := DeleteFinishedVideoTasksBefore(time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}

	for _, id := range []string{"image-workbench", "image-workflow", "image-active", "video-workbench", "video-active"} {
		var count int64
		table := "canvas_image_tasks"
		if id[:6] == "video-" {
			table = "video_tasks"
		}
		if err := database.Table(table).Where("id = ?", id).Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("workbench/workflow task %s was deleted", id)
		}
	}
	for _, id := range []string{"image-canvas", "video-canvas"} {
		var count int64
		table := "canvas_image_tasks"
		if id[:6] == "video-" {
			table = "video_tasks"
		}
		if err := database.Table(table).Where("id = ?", id).Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("canvas task %s was retained", id)
		}
	}
}
