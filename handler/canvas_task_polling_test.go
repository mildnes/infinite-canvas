package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestMissingCanvasTaskPollsReturn404(t *testing.T) {
	if os.Getenv("IC_TASK_POLL_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestMissingCanvasTaskPollsReturn404$", "-test.v")
		command.Env = append(os.Environ(), "IC_TASK_POLL_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("task polling fixture: %v\n%s", err, output)
		}
		return
	}
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "polling.db")
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	ctx := service.WithUser(context.Background(), model.AuthUser{ID: "owner"})
	for _, kind := range []string{"image", "audio", "video"} {
		id := "client_" + kind + "_task_existing"
		var task any = &model.CanvasImageTask{ID: id, UserID: "owner", Status: "completed"}
		if kind == "audio" {
			task = &model.CanvasAudioTask{ID: id, UserID: "owner", Status: "completed"}
		} else if kind == "video" {
			task = &model.VideoTask{ID: id, UserID: "owner", Status: "completed"}
		}
		if err := db.Create(task).Error; err != nil {
			t.Fatal(err)
		}
		for _, suffix := range []string{"missing", "existing"} {
			t.Run(kind+"/"+suffix, func(t *testing.T) {
				request := httptest.NewRequest(http.MethodGet, "/task", nil).WithContext(ctx)
				response := httptest.NewRecorder()
				taskID := "client_" + kind + "_task_" + suffix
				if kind == "image" {
					GetCanvasImageTask(response, request, taskID)
				} else if kind == "audio" {
					GetCanvasAudioTask(response, request, taskID)
				} else if !serveAIVideoTask(response, request, taskID) {
					t.Fatal("missing canvas video task falls through to upstream")
				}
				want := http.StatusOK
				if suffix == "missing" {
					want = http.StatusNotFound
				}
				if response.Code != want {
					t.Errorf("status=%d want=%d body=%s", response.Code, want, response.Body)
				}
			})
		}
	}
	if serveAIVideoTask(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/task", nil).WithContext(ctx), "upstream-task") {
		t.Error("upstream video task fallback changed")
	}
}
