package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestVideoBillingCapturedSecondsAndRefund(t *testing.T) {
	if os.Getenv("IC_VIDEO_BILLING_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestVideoBillingCapturedSecondsAndRefund$", "-test.v")
		command.Env = append(os.Environ(), "IC_VIDEO_BILLING_FIXTURE=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("video billing fixture: %v\n%s", err, output)
		}
		t.Logf("%s", output)
		return
	}
	root := t.TempDir()
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(root, "billing.db")
	config.Cfg.AILogDir = filepath.Join(root, "logs")
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
			if err := r.ParseMultipartForm(32 << 20); err != nil {
				t.Error(err)
				http.Error(w, "invalid request", 400)
				return
			}
			defer r.MultipartForm.RemoveAll()
			payload = map[string]any{"prompt": r.FormValue("prompt")}
		} else {
			_ = json.NewDecoder(r.Body).Decode(&payload)
		}
		switch payload["prompt"] {
		case "stop":
			entered <- struct{}{}
			<-r.Context().Done()
			return
		case "failure":
			http.Error(w, "fixture failure", 502)
			return
		case "business-failure":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, "{\"code\":1,\"msg\":\"fixture failure\"}")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "{\"id\":\"upstream-task\",\"status\":\"queued\"}")
	}))
	defer upstream.Close()
	for _, item := range []struct {
		name       string
		price      float64
		seconds    string
		mode       string
		multipart  bool
		wantAmount float64
	}{
		{"ten-seconds", 7, "10", "success", false, 70},
		{"five-seconds-multipart", 7, "5", "success", true, 35},
		{"smart-duration", 7, "-1", "success", false, 105},
		{"fractional-success", 0.37, "10", "success", false, 3.7},
		{"fractional-failure", 0.37, "10", "failure", false, 3.7},
		{"fractional-business-failure", 0.37, "10", "business-failure", false, 3.7},
		{"fractional-stop", 0.37, "10", "stop", false, 3.7},
		{"unpriced", 0, "10", "success", false, 0},
	} {
		t.Run(item.name, func(t *testing.T) {
			user := model.AuthUser{ID: item.name, Role: model.UserRoleAdmin}
			if err := db.Create(&model.User{ID: user.ID, Username: user.ID, AffCode: user.ID, Credits: 1000}).Error; err != nil {
				t.Fatal(err)
			}
			settings := model.Settings{}
			settings.Private.Channels = []model.ModelChannel{{ID: "video-billing", Protocol: "openai", BaseURL: upstream.URL, APIKey: "fixture", Enabled: true, Models: []string{"video-fixture"}}}
			settings.Public.ModelChannel.AvailableModels = []string{"video-fixture"}
			var cost model.ModelCost
			if err := json.Unmarshal([]byte(fmt.Sprintf("{\"channelId\":\"video-billing\",\"model\":\"video-fixture\",\"credits\":%g}", item.price)), &cost); err != nil {
				t.Fatalf("fractional model cost: %v", err)
			}
			settings.Public.ModelChannel.ModelCosts = []model.ModelCost{cost}
			if _, err := repository.SaveSettings(settings, "now"); err != nil {
				t.Fatal(err)
			}
			id := "client_video_task_" + item.name
			data, _ := json.Marshal(map[string]any{"model": "video-fixture", "prompt": item.mode, "seconds": item.seconds})
			contentType := "application/json"
			if item.multipart {
				var encoded bytes.Buffer
				writer := multipart.NewWriter(&encoded)
				for key, value := range map[string]string{"model": "video-fixture", "prompt": item.mode, "seconds": item.seconds} {
					_ = writer.WriteField(key, value)
				}
				_ = writer.Close()
				data, contentType = encoded.Bytes(), writer.FormDataContentType()
			}
			request := httptest.NewRequest(http.MethodPost, "/api/v1/videos", bytes.NewReader(data)).WithContext(service.WithUser(context.Background(), user))
			request.Header.Set("Content-Type", contentType)
			request.Header.Set("X-Model-Channel-ID", "video-billing")
			request.Header.Set("X-Client-Video-Task-ID", id)
			done := make(chan struct{})
			response := httptest.NewRecorder()
			go func() {
				defer close(done)
				proxyAIVideoTaskRequest(response, request)
			}()
			if item.mode == "stop" {
				select {
				case <-entered:
				case <-time.After(3 * time.Second):
					t.Fatal("upstream not entered")
				}
				for attempt := 0; attempt < 2; attempt++ {
					if status, _, _, err := service.StopCanvasTask("video", user.ID, id); err != nil || status != "cancelled" {
						t.Fatalf("stop: status=%s err=%v", status, err)
					}
				}
			}
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("video request did not finish")
			}
			task, found, err := service.GetUserVideoTask(user.ID, id)
			if err != nil || !found {
				t.Fatalf("missing task: %v; response=%s", err, response.Body.String())
			}
			if math.Abs(float64(task.Credits)-item.wantAmount) > 1e-9 {
				t.Errorf("captured credits=%g want=%g", float64(task.Credits), item.wantAmount)
			}
			var logs []model.CreditLog
			if err := db.Where("user_id = ?", user.ID).Find(&logs).Error; err != nil {
				t.Fatal(err)
			}
			consumes, refunds := 0, 0
			for _, entry := range logs {
				if math.Abs(math.Abs(float64(entry.Amount))-item.wantAmount) > 1e-9 {
					t.Errorf("ledger amount=%g want=%g", float64(entry.Amount), item.wantAmount)
				}
				if entry.Type == model.CreditLogTypeAIConsume {
					consumes++
				}
				if entry.Type == model.CreditLogTypeAIRefund {
					refunds++
					wantRemark := "模型调用失败返还 video-fixture"
					if item.mode == "stop" {
						wantRemark = "用户停止返还 video-fixture"
					}
					if entry.Remark != wantRemark {
						t.Errorf("refund remark=%q want=%q", entry.Remark, wantRemark)
					}
				}
			}
			wantConsumes, wantRefunds := 1, 0
			if item.price == 0 {
				wantConsumes = 0
			} else if item.mode != "success" {
				wantRefunds = 1
			}
			var saved model.User
			db.First(&saved, "id = ?", user.ID)
			wantBalance := 1000 - float64(wantConsumes-wantRefunds)*item.wantAmount
			if consumes != wantConsumes || refunds != wantRefunds || math.Abs(float64(saved.Credits)-wantBalance) > 1e-9 {
				t.Errorf("consume=%d refund=%d balance=%g want=%d/%d/%g", consumes, refunds, float64(saved.Credits), wantConsumes, wantRefunds, wantBalance)
			}
			t.Logf("seconds=%s consume=%d refund=%d charge=%g balance=%g", item.seconds, consumes, refunds, float64(task.Credits), float64(saved.Credits))
		})
	}
}
