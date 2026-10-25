package repository

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func resultDB(t *testing.T) *gorm.DB {
	t.Helper()
	previousConfig := config.Cfg
	previousDB, previousErr, previousOnce := db, dbErr, dbOnce
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "results.db")
	db, dbErr, dbOnce = nil, nil, sync.Once{}
	t.Cleanup(func() {
		if db != nil {
			connection, _ := db.DB()
			_ = connection.Close()
		}
		config.Cfg = previousConfig
		db, dbErr, dbOnce = previousDB, previousErr, previousOnce
	})
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	return database
}

func resultTask(id string) model.CanvasImageTask {
	old := time.Now().UTC().Add(-20 * time.Minute).Format(time.RFC3339Nano)
	return model.CanvasImageTask{ID: id, UserID: "owner", Source: "canvas", SourceID: "board", NodeID: "node", Status: "completed", Progress: 100,
		ImageURL: "/api/files/object/content", StorageKey: "server:object", Width: 3840, Height: 2160, Bytes: 12345, MimeType: "image/png", CompletedAt: old,
		RequestBody: strings.Repeat("inline-request", 1000), ResponseBody: strings.Repeat("inline-response", 1000), OriginalURL: "data:image/png;base64,AAAA"}
}

func TestCanvasImageResultSurvivesTaskRetention(t *testing.T) {
	database := resultDB(t)
	task := resultTask("completed")
	active := task
	active.Status = "processing"
	active.CompletedAt = ""
	if err := database.Create(&active).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := UpdateCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	if err := DeleteFinishedCanvasImageTasksBefore(time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	var count int64
	database.Model(&model.CanvasImageTask{}).Where("id = ?", task.ID).Count(&count)
	if count != 0 {
		t.Fatal("task detail retention must remain ten minutes")
	}
	got, found, err := GetUserCanvasImageTask("owner", task.ID)
	if err != nil || !found || got.ImageURL != task.ImageURL || got.Status != "completed" {
		t.Fatalf("durable completed result lost: found=%v got=%+v err=%v", found, got, err)
	}
	if got.RequestBody != "" || got.ResponseBody != "" || got.OriginalURL != "" {
		t.Fatal("archive retained request/response/inline media")
	}
	if _, found, err := GetUserCanvasImageTask("other", task.ID); err != nil || found {
		t.Fatalf("foreign result exposed: found=%v err=%v", found, err)
	}
	batch, err := BatchUserCanvasImageTasks("owner", []string{task.ID, task.ID, "missing"})
	if err != nil || len(batch) != 1 || batch[0].StorageKey != task.StorageKey {
		t.Fatalf("batch recovery %+v %v", batch, err)
	}
	foreign, err := BatchUserCanvasImageTasks("other", []string{task.ID})
	if err != nil || len(foreign) != 0 {
		t.Fatal("foreign batch leaked archived result")
	}
	tasks, err := ListUserCanvasImageTasks("owner", []string{"canvas"}, 100)
	if err != nil || len(tasks) != 0 {
		t.Fatal("archive became an active task")
	}
	if awake, err := HasFinishedGenerationTasks(); err != nil || awake {
		t.Fatalf("archive must not keep polling alive: %v %v", awake, err)
	}
}

func TestCanvasImageRetentionArchivesPreUpgradeCompletedRows(t *testing.T) {
	database := resultDB(t)
	task := resultTask("pre-upgrade")
	if err := database.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := DeleteFinishedCanvasImageTasksBefore(time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	got, found, err := GetUserCanvasImageTask("owner", task.ID)
	if err != nil || !found || got.ImageURL != task.ImageURL {
		t.Fatalf("cleanup erased existing completed result: %+v %v %v", got, found, err)
	}
}

func TestCanvasImageResultArchiveFailureRollsBackCompletionAndCleanup(t *testing.T) {
	database := resultDB(t)
	task := resultTask("atomic-complete")
	active := task
	active.Status = "processing"
	active.CompletedAt = ""
	if err := database.Create(&active).Error; err != nil {
		t.Fatal(err)
	}
	const hook = "reject-result-archive"
	if err := database.Callback().Create().Before("gorm:create").Register(hook, func(tx *gorm.DB) {
		if tx.Statement.Table == "canvas_image_task_results" {
			tx.AddError(errors.New("archive storage failed"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer database.Callback().Create().Remove(hook)
	if _, err := UpdateCanvasImageTask(task); err == nil {
		t.Fatal("result archive failure did not reject completion")
	}
	got, _, err := GetUserCanvasImageTask("owner", task.ID)
	if err != nil || got.Status != "processing" {
		t.Fatal("completion was not rolled back")
	}
	old := resultTask("atomic-cleanup")
	if err := database.Create(&old).Error; err != nil {
		t.Fatal(err)
	}
	if err := DeleteFinishedCanvasImageTasksBefore(time.Now().UTC().Format(time.RFC3339Nano)); err == nil {
		t.Fatal("cleanup deleted result before durable archive committed")
	}
	var count int64
	database.Model(&model.CanvasImageTask{}).Where("id = ?", old.ID).Count(&count)
	if count != 1 {
		t.Fatal("failed archive lost original task row")
	}
}

func TestCanvasImageResultNeverRevivesCancelledOrFailedTasks(t *testing.T) {
	database := resultDB(t)
	for _, status := range []string{"cancelled", "failed"} {
		task := resultTask(status)
		task.Status = status
		task.ImageURL = ""
		task.StorageKey = ""
		if err := database.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
		late := resultTask(status)
		got, err := UpdateCanvasImageTask(late)
		if err != nil || got.Status != status {
			t.Fatal("late completion revived terminal task")
		}
	}
	if err := DeleteFinishedCanvasImageTasksBefore(time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"cancelled", "failed"} {
		if _, found, err := GetUserCanvasImageTask("owner", id); err != nil || found {
			t.Fatal("terminal failure/cancelled was resurrected from result archive")
		}
	}
}
