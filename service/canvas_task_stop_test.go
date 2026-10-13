package service

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

func TestCanvasStopOwnershipRefundAndTerminalGuards(t *testing.T) {
	if os.Getenv("IC_STOP_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestCanvasStopOwnershipRefundAndTerminalGuards$", "-test.v")
		command.Env = append(os.Environ(), "IC_STOP_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("stop fixture: %v\n%s", err, output)
		}
		return
	}
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "stop.db")
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	user := model.User{ID: "stop-owner", Username: "stop-owner", AffCode: "stop-owner", Credits: 50}
	if err = db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"image", "audio", "video"} {
		id := "stop-" + kind
		switch kind {
		case "image":
			err = db.Create(&model.CanvasImageTask{ID: id, UserID: user.ID, Status: "processing", Credits: 3, ChannelID: "channel", Model: "local", Endpoint: "/images/generations"}).Error
		case "audio":
			err = db.Create(&model.CanvasAudioTask{ID: id, UserID: user.ID, Status: "processing", Credits: 3, ChannelID: "channel", Model: "local", Endpoint: "/audio/speech"}).Error
		case "video":
			err = db.Create(&model.VideoTask{ID: id, UserID: user.ID, Status: "processing", Credits: 3, ChannelID: "channel", Model: "local"}).Error
		}
		if err != nil {
			t.Fatal(err)
		}
		ctx, release := CanvasTaskContext(kind, user.ID, id)
		if status, stopped, refunded, err := StopCanvasTask(kind, "other", id); !errors.Is(err, ErrCanvasTaskNotFound) || status != "" || stopped || refunded || ctx.Err() != nil {
			t.Fatalf("cross-user stop: %q %v %v %v", status, stopped, refunded, err)
		}
		if status, stopped, refunded, err := StopCanvasTask(kind, user.ID, id); err != nil || status != "cancelled" || !stopped || !refunded || ctx.Err() == nil {
			t.Fatalf("stop: %q %v %v %v", status, stopped, refunded, err)
		}
		if status, stopped, refunded, err := StopCanvasTask(kind, user.ID, id); err != nil || status != "cancelled" || stopped || refunded {
			t.Fatalf("repeat: %q %v %v %v", status, stopped, refunded, err)
		}
		release()
		late, done := CanvasTaskContext(kind, user.ID, id)
		if late.Err() == nil {
			t.Fatal("stop before registration must cancel late runner")
		}
		done()
	}
	if err = db.First(&user, "id = ?", user.ID).Error; err != nil || user.Credits != 59 {
		t.Fatalf("refund exactly once: %+v %v", user, err)
	}
	var logs []model.CreditLog
	db.Find(&logs)
	if len(logs) != 3 {
		t.Fatalf("refund audit count: %d", len(logs))
	}
	for _, entry := range logs {
		if entry.Remark != "用户停止返还 local" {
			t.Fatalf("stop refund remark: %q", entry.Remark)
		}
	}
	for _, status := range []string{"completed", "failed"} {
		task := model.CanvasImageTask{ID: status, UserID: user.ID, Status: status, Credits: 5}
		db.Create(&task)
		got, stopped, refunded, err := StopCanvasTask("image", user.ID, task.ID)
		if err != nil || got != status || stopped || refunded {
			t.Fatalf("terminal rewritten: %s %v", got, err)
		}
	}
	stale := model.CanvasImageTask{ID: "stop-image", UserID: user.ID, Status: "completed", ImageURL: "late-result"}
	saved, err := repository.UpdateCanvasImageTask(stale)
	if err != nil || saved.Status != "cancelled" || saved.ImageURL != "" {
		t.Fatalf("late result revived: %+v %v", saved, err)
	}
	if err = UpdateVideoTaskFromPoll(model.VideoTask{ID: "stop-video", UserID: user.ID, Status: "processing"}, VideoTaskPollUpdate{Status: "completed", VideoURL: "http://must-not-download.invalid/video"}); err != nil {
		t.Fatal(err)
	}
	video, _, _ := repository.GetUserVideoTask(user.ID, "stop-video")
	if video.Status != "cancelled" || video.VideoURL != "" {
		t.Fatal("cancelled video revived")
	}
	if NormalizeVideoTaskStatus("canceled") != "cancelled" || IsFailedVideoTaskStatus("cancelled") || IsCompletedVideoTaskStatus("cancelled") {
		t.Fatal("cancelled is a separate terminal")
	}
	for _, kind := range []string{"image", "audio", "video"} {
		id := workflowTaskID(user.ID, kind, "client_"+kind+"_task_workflow")
		ref := `{"scope":"system","channelId":"channel","kind":"runninghub","workflowId":"example"}`
		switch kind {
		case "image":
			err = db.Create(&model.CanvasImageTask{ID: id, UserID: user.ID, Status: "running", WorkflowRef: ref, Credits: 2, ChannelID: "channel"}).Error
		case "audio":
			err = db.Create(&model.CanvasAudioTask{ID: id, UserID: user.ID, Status: "running", WorkflowRef: ref, Credits: 2, ChannelID: "channel"}).Error
		case "video":
			err = db.Create(&model.VideoTask{ID: id, UserID: user.ID, Status: "running", WorkflowRef: ref, Credits: 2, ChannelID: "channel"}).Error
		}
		if err != nil {
			t.Fatal(err)
		}
		status, stopped, refunded, err := StopCanvasTask("workflow", user.ID, "client_"+kind+"_task_workflow")
		if err != nil || status != "cancelled" || !stopped || !refunded {
			t.Fatalf("workflow stop: %s %v", status, err)
		}
		if err = finishWorkflowTask(id, "completed", []string{"http://must-not-download.invalid/result"}, ""); err != nil {
			t.Fatal(err)
		}
		result, err := GetWorkflowTask(context.Background(), model.AuthUser{ID: user.ID}, id)
		if err != nil || result.Status != "cancelled" || len(result.URLs) != 0 {
			t.Fatalf("workflow revived: %+v %v", result, err)
		}
	}
	db.Find(&logs)
	for _, entry := range logs[3:] {
		if !strings.Contains(entry.Extra, "/api/v1/workflow-tasks") || !strings.Contains(entry.Extra, "workflow:system:channel:") {
			t.Fatalf("wrong workflow refund identity: %s", entry.Extra)
		}
	}
	// Roll back both status and credit changes if the existing refund audit fails.
	rollbackTask := model.CanvasImageTask{ID: "refund-failure", UserID: user.ID, Status: "processing", ChannelID: "channel", Credits: 4}
	db.Create(&rollbackTask)
	const callbackName = "stop-refund-failure"
	db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == "credit_logs" {
			tx.AddError(context.Canceled)
		}
	})
	_, stopped, refunded, err := StopCanvasTask("image", user.ID, rollbackTask.ID)
	db.Callback().Create().Remove(callbackName)
	if err == nil || stopped || refunded {
		t.Fatal("failed refund was reported successful")
	}
	persisted, _, _ := repository.GetUserCanvasImageTask(user.ID, rollbackTask.ID)
	if persisted.Status != "processing" {
		t.Fatal("failed refund must roll back cancellation")
	}
	if _, stopped, refunded, err = StopCanvasTask("image", user.ID, rollbackTask.ID); err != nil || !stopped || !refunded {
		t.Fatalf("refund retry: %v", err)
	}
	// A user-owned channel must not refund captured credits.
	local := model.CanvasAudioTask{ID: "local", UserID: user.ID, Status: "processing", UserChannelID: "own", Credits: 9}
	db.Create(&local)
	if _, stopped, refunded, err = StopCanvasTask("audio", user.ID, local.ID); err != nil || !stopped || refunded {
		t.Fatal("local channel refund")
	}
	concurrent := model.CanvasImageTask{ID: "concurrent", UserID: user.ID, Status: "queued", ChannelID: "channel", Credits: 1}
	db.Create(&concurrent)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, _, err := StopCanvasTask("image", user.ID, concurrent.ID); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	var count int64
	db.Model(&model.CreditLog{}).Where("amount = ?", 1).Count(&count)
	if count != 1 {
		t.Fatalf("concurrent stop refunded %d times", count)
	}
}
