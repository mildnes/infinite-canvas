package repository

import (
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestNodeDeletionRetainsTasksAndAudioCleanupHonorsTenMinutes(t *testing.T) {
	previousConfig := config.Cfg
	previousDB, previousErr, previousOnce := db, dbErr, dbOnce
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "tasks.db")
	db, dbErr, dbOnce = nil, nil, sync.Once{}
	t.Cleanup(func() {
		if db != nil {
			conn, _ := db.DB()
			conn.Close()
		}
		config.Cfg = previousConfig
		db, dbErr, dbOnce = previousDB, previousErr, previousOnce
	})
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	image := model.CanvasImageTask{ID: "image", UserID: "owner", Source: "canvas", SourceID: "project", NodeID: "node", Status: "processing"}
	audio := model.CanvasAudioTask{ID: "audio", UserID: "owner", Source: "canvas", SourceID: "project", NodeID: "node", Status: "processing"}
	database.Create(&image)
	database.Create(&audio)
	if err = DeleteUserCanvasTasks("owner", "project", []string{"node"}); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := GetUserCanvasImageTask("owner", image.ID); !found {
		t.Fatal("node deletion erased image billing/audit record")
	}
	if _, found, _ := GetUserCanvasAudioTask("owner", audio.ID); !found {
		t.Fatal("node deletion erased audio billing/audit record")
	}
	image.Status = "completed"
	image.ImageURL = "/api/files/image/content"
	image.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	saved, err := UpdateCanvasImageTask(image)
	if err != nil || saved.ImageURL != image.ImageURL {
		t.Fatalf("deleted node's task cannot complete: %+v %v", saved, err)
	}
	current := time.Now().UTC()
	before := current.Add(-10 * time.Minute).Format(time.RFC3339Nano)
	for _, status := range []string{"completed", "failed", "cancelled"} {
		for _, age := range []int{11, 9} {
			id := status + time.Duration(age).String()
			task := model.CanvasAudioTask{ID: id, UserID: "owner", Status: status, CompletedAt: current.Add(-time.Duration(age) * time.Minute).Format(time.RFC3339Nano)}
			database.Create(&task)
		}
	}
	if err = DeleteFinishedCanvasAudioTasksBefore(before); err != nil {
		t.Fatal(err)
	}
	var tasks []model.CanvasAudioTask
	database.Find(&tasks)
	if len(tasks) != 4 {
		t.Fatalf("old terminals should be gone; three recent + active remain: %+v", tasks)
	}
	for _, task := range tasks {
		if task.CompletedAt != "" && task.CompletedAt < before {
			t.Fatalf("expired task retained: %+v", task)
		}
	}
	audio.Status = "completed"
	audio.AudioURL = "/api/files/audio/content"
	audio.CompletedAt = current.Format(time.RFC3339Nano)
	if _, err = UpdateCanvasAudioTask(audio); err != nil {
		t.Fatal(err)
	}
	if err = DeleteUserCanvasTasks("owner", "project", nil); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := GetUserCanvasAudioTask("owner", audio.ID); !found {
		t.Fatal("empty-node-list API must also preserve task history")
	}
	image.Status = "cancelled"
	image.CompletedAt = current.Add(-11 * time.Minute).Format(time.RFC3339Nano)
	database.Save(&image)
	if err = DeleteFinishedCanvasImageTasksBefore(before); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := GetUserCanvasImageTask("owner", image.ID); found {
		t.Fatal("expired cancelled image not cleaned")
	}
	if active, err := HasActiveCanvasAudioTasks(); err != nil || active {
		t.Fatalf("completed audio not active: %v %v", active, err)
	}
	if retained, err := HasFinishedGenerationTasks(); err != nil || !retained {
		t.Fatalf("terminal-only history must keep cleaner awake: %v %v", retained, err)
	}
}
