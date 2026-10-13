package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestCanvasStopCancelsRealUpstreamAndNeverPersistsResult(t *testing.T) {
	if os.Getenv("IC_STOP_HTTP_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestCanvasStopCancelsRealUpstreamAndNeverPersistsResult$", "-test.v")
		command.Env = append(os.Environ(), "IC_STOP_HTTP_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("HTTP cancellation: %v\n%s", err, output)
		}
		return
	}
	root := t.TempDir()
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(root, "stop.db")
	config.Cfg.AILogDir = filepath.Join(root, "logs")
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	user := model.AuthUser{ID: "stop-user", Role: model.UserRoleAdmin}
	db.Create(&model.User{ID: user.ID, Username: user.ID, AffCode: user.ID, Credits: 50})
	entered, cancelled := make(chan struct{}, 1), make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		entered <- struct{}{}
		select {
		case <-r.Context().Done():
			cancelled <- struct{}{}
		case <-time.After(5 * time.Second):
			_, _ = io.WriteString(w, `{"data":[{"url":"https://must-not-persist.invalid/late.png"}]}`)
		}
	}))
	defer upstream.Close()
	settings := model.Settings{}
	settings.Private.Channels = []model.ModelChannel{{ID: "stop", Protocol: "openai", BaseURL: upstream.URL, APIKey: "fixture", Enabled: true, Models: []string{"gpt-image-2", "tts", "video"}}}
	settings.Public.ModelChannel.AvailableModels = []string{"gpt-image-2", "tts", "video"}
	repository.SaveSettings(settings, "now")
	for _, kind := range []string{"image", "audio", "video"} {
		id := "client_" + kind + "_task_stop-http"
		request := httptest.NewRequest(http.MethodPost, "/api/v1/canvas/tasks/stop", nil)
		request = request.WithContext(service.WithUser(context.Background(), user))
		done := make(chan struct{})
		switch kind {
		case "image":
			task := model.CanvasImageTask{ID: id, UserID: user.ID, Status: "queued", Model: "gpt-image-2", ChannelID: "stop", Endpoint: "/images/generations"}
			db.Create(&task)
			go func() {
				defer close(done)
				runCanvasImageTask(task, user, []byte(`{"model":"gpt-image-2","prompt":"test"}`), "application/json", "stop", "", "gpt-image-2")
			}()
		case "audio":
			task := model.CanvasAudioTask{ID: id, UserID: user.ID, Status: "queued", Model: "tts", ChannelID: "stop", Endpoint: "/audio/speech"}
			db.Create(&task)
			go func() {
				defer close(done)
				runCanvasAudioTask(task, user, []byte(`{"model":"tts","input":"test"}`), "application/json", "stop", "")
			}()
		case "video":
			r := httptest.NewRequest(http.MethodPost, "/api/v1/videos", bytes.NewBufferString(`{"model":"video","prompt":"test"}`)).WithContext(service.WithUser(context.Background(), user))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-Model-Channel-ID", "stop")
			r.Header.Set("X-Client-Video-Task-ID", id)
			go func() { defer close(done); proxyAIVideoTaskRequest(httptest.NewRecorder(), r) }()
		}
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("upstream not reached")
		}
		payload, _ := json.Marshal(map[string]string{"kind": kind, "taskId": id})
		request.Body = io.NopCloser(bytes.NewReader(payload))
		w := httptest.NewRecorder()
		StopCanvasTask(w, request)
		var result struct {
			Code int
			Data struct {
				Status  string
				Stopped bool
			}
		}
		json.Unmarshal(w.Body.Bytes(), &result)
		if result.Code != 0 || result.Data.Status != "cancelled" || !result.Data.Stopped {
			t.Fatalf("stop API: %s", w.Body)
		}
		select {
		case <-cancelled:
		case <-time.After(2 * time.Second):
			t.Fatal("real outgoing context not cancelled")
		}
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("runner did not release")
		}
	}
	var count int64
	db.Model(&model.StorageObject{}).Count(&count)
	if count != 0 {
		t.Fatalf("cancelled result persisted: %d", count)
	}
}
