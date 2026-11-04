package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"log"
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
	"gorm.io/gorm"
)

type canvasOriginalURLTransport struct {
	http.RoundTripper
	data []byte
}

func (transport canvasOriginalURLTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Hostname() == "images.example" {
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"image/png"}}, Body: io.NopCloser(bytes.NewReader(transport.data))}, nil
	}
	return transport.RoundTripper.RoundTrip(request)
}

func TestCanvasImageTaskOriginalURLCompaction(t *testing.T) {
	if os.Getenv("IC_CANVAS_ORIGINAL_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestCanvasImageTaskOriginalURLCompaction$", "-test.v")
		command.Env = append(os.Environ(), "IC_CANVAS_ORIGINAL_FIXTURE=1")
		output, err := command.CombinedOutput()
		t.Logf("%s", output)
		if err != nil {
			t.Fatalf("original URL fixture: %v", err)
		}
		return
	}
	root := t.TempDir()
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(root, "originals.db")
	config.Cfg.AILogDir = filepath.Join(root, "logs")
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 3840, 2160))); err != nil {
		t.Fatal(err)
	}
	largeImage := append(encoded.Bytes(), bytes.Repeat([]byte{0x81, 0x82}, 1<<20)...)
	inline := func(suffix byte) string {
		return "data:image/png;base64," + base64.StdEncoding.EncodeToString(append(append([]byte(nil), largeImage...), suffix))
	}
	client := service.SafeProxyHTTPClient()
	previousTransport := client.Transport
	client.Transport = canvasOriginalURLTransport{RoundTripper: previousTransport, data: largeImage}
	defer func() { client.Transport = previousTransport }()
	responseBodies := map[string]string{
		"http-failure":          `{"error":{"message":"fixture failure","private":"data:image/png;base64,AAAA"}}`,
		"wrapped-failure":       `{"code":1,"msg":"fixture failure","private":"data:image/png;base64,AAAA"}`,
		"wrapped-large-failure": `{"code":1,"msg":"fixture failure","private":"data:image/png;base64,` + strings.Repeat("A", 9000) + `"}`,
		"invalid-result":        `{"private":"data:image/png;base64,AAAA"}`,
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct{ Prompt string }
		_ = json.NewDecoder(request.Body).Decode(&body)
		writer.Header().Set("Content-Type", "application/json")
		if response, exists := responseBodies[body.Prompt]; exists {
			if body.Prompt == "http-failure" {
				writer.WriteHeader(http.StatusBadGateway)
			}
			_, _ = io.WriteString(writer, response)
			return
		}
		urls := []string{inline(1)}
		switch body.Prompt {
		case "duplicate":
			urls = append(urls, urls[0])
		case "multiple", "ordinary-model-multiple":
			urls = append(urls, inline(2), urls[0])
		case "https":
			urls = []string{"https://images.example/a.png"}
		case "persist-failure":
			urls = []string{inline(3)}
		}
		var results []map[string]string
		for _, source := range urls {
			results = append(results, map[string]string{"url": source})
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"data": results})
	}))
	defer upstream.Close()
	const layerModel = "seedream/5-pro-layer-decomposition"
	models := []string{"gpt-image-2", layerModel}
	settings := model.Settings{}
	settings.Private.Channels = []model.ModelChannel{{ID: "originals", Protocol: "openai", Enabled: true, APIKey: "fixture", BaseURL: upstream.URL, Models: models}}
	settings.Public.ModelChannel.AvailableModels = models
	if _, err := repository.SaveSettings(settings, "now"); err != nil {
		t.Fatal(err)
	}
	user := model.AuthUser{ID: "original-owner", Role: model.UserRoleAdmin}
	if err := database.Create(&model.User{ID: user.ID, Username: user.ID, AffCode: user.ID, Credits: 100}).Error; err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"inline", "duplicate", "multiple", "ordinary-model-multiple", "https", "http-failure", "wrapped-failure", "wrapped-large-failure", "invalid-result", "persist-failure"} {
		t.Run(mode, func(t *testing.T) {
			var warnings bytes.Buffer
			previousWriter := log.Writer()
			log.SetOutput(&warnings)
			defer log.SetOutput(previousWriter)
			uploads := 0
			const callback = "canvas-original-upload"
			if err := database.Callback().Create().Before("gorm:create").Register(callback, func(transaction *gorm.DB) {
				if transaction.Statement.Table == "storage_objects" {
					uploads++
					if mode == "persist-failure" {
						transaction.AddError(errors.New("fixture upload failed"))
					}
				}
			}); err != nil {
				t.Fatal(err)
			}
			defer database.Callback().Create().Remove(callback)
			modelName, credits := layerModel, 0.0
			if mode == "ordinary-model-multiple" {
				modelName = "gpt-image-2"
			}
			if mode == "persist-failure" {
				credits = 3
			}
			task, err := service.CreateCanvasImageTask(service.CanvasImageTaskCreateInput{
				UserID: user.ID, ClientTaskID: "original-" + mode, Model: modelName, ChannelID: "originals", Endpoint: "/images/generations",
				SourceID: "original-board", NodeID: "original-node-" + mode, Credits: credits, BillingName: modelName, BillingPath: "/images/generations",
			})
			if err != nil || task.Status != "queued" {
				t.Fatalf("task creation failed: status=%s err=%v", task.Status, err)
			}
			body, _ := json.Marshal(map[string]string{"model": task.Model, "prompt": mode})
			runCanvasImageTask(task, user, body, "application/json", task.ChannelID, "", task.Model)
			saved, found, err := service.GetUserCanvasImageTask(user.ID, task.ID)
			if err != nil || !found {
				t.Fatalf("created task lost: found=%v err=%v", found, err)
			}
			if payload, exists := responseBodies[mode]; exists {
				if mode == "http-failure" {
					payload = "{\"code\":1,\"data\":null,\"msg\":\"fixture failure\"}\n"
				}
				expected := fmt.Sprintf("响应大小：%d bytes；Content-Type：application/json", len(payload))
				if saved.Status != "failed" || saved.ErrorDetail != expected || saved.ResponseBody != "" {
					t.Fatalf("failure response not summarized: status=%s detail=%q responseBytes=%d", saved.Status, saved.ErrorDetail, len(saved.ResponseBody))
				}
				return
			}
			if mode == "persist-failure" {
				if saved.Status != "failed" || saved.Error == "" || saved.ErrorDetail != "fixture upload failed" || uploads != 1 {
					t.Errorf("storage failure was not preserved: status=%s error=%q detail=%q uploads=%d", saved.Status, saved.Error, saved.ErrorDetail, uploads)
				}
				if saved.OriginalURL != "" || strings.Contains(strings.Join(saved.OriginalURLs, ""), "data:") {
					t.Error("failed upload retained inline original")
				}
				if !strings.Contains(warnings.String(), "WARN") || !strings.Contains(warnings.String(), task.ID) || !strings.Contains(warnings.String(), "bytes=") || !strings.Contains(warnings.String(), "fixture upload failed") {
					t.Errorf("normalization warning missing: %s", warnings.String())
				}
				if changed, err := service.FailCanvasImageTask(saved, saved.Error, saved.ErrorDetail); err != nil || changed {
					t.Errorf("failure repeated: changed=%v err=%v", changed, err)
				}
				var ledger []model.CreditLog
				if err := database.Where("user_id = ?", user.ID).Find(&ledger).Error; err != nil {
					t.Fatal(err)
				}
				if len(ledger) != 2 {
					t.Fatalf("expected one charge and one refund, got %d", len(ledger))
				}
				var balance float64
				charges, refunds := 0, 0
				for _, entry := range ledger {
					balance += entry.Amount
					if entry.Type == model.CreditLogTypeAIConsume && entry.Amount == -3 {
						charges++
					}
					if entry.Type == model.CreditLogTypeAIRefund && entry.Amount == 3 {
						refunds++
					}
				}
				if balance != 0 || charges != 1 || refunds != 1 {
					t.Errorf("failure was not refunded exactly once: %+v", ledger)
				}
				return
			}
			if saved.Status != "completed" {
				t.Fatalf("image task failed: status=%s detail=%q", saved.Status, saved.ErrorDetail)
			}
			if mode == "https" {
				if saved.OriginalURL != "https://images.example/a.png" {
					t.Fatalf("HTTP original changed: %q", saved.OriginalURL)
				}
				return
			}
			if !strings.HasPrefix(saved.OriginalURL, "server:") || saved.OriginalURL != saved.StorageKey {
				t.Errorf("inline original was not replaced with storage key: originalBytes=%d", len(saved.OriginalURL))
			}
			expectedCount := 1
			if mode == "multiple" {
				expectedCount = 2
				if len(saved.ImageURLs) != 2 || len(saved.ImageStorage) != 2 || uploads != 1 {
					t.Fatalf("multi-image persistence duplicated or lost images: urls=%d storage=%d newUploads=%d", len(saved.ImageURLs), len(saved.ImageStorage), uploads)
				}
				if saved.ImageURLs[0] == saved.ImageURLs[1] || saved.ImageStorage[0].StorageKey == saved.ImageStorage[1].StorageKey {
					t.Error("distinct image outputs share the same stored result")
				}
			} else if len(saved.ImageURLs) != 0 || len(saved.ImageStorage) != 0 {
				t.Errorf("single image redundantly retained in arrays: urls=%d storage=%d", len(saved.ImageURLs), len(saved.ImageStorage))
			}
			if len(saved.OriginalURLs) != expectedCount {
				t.Fatalf("original count=%d want=%d", len(saved.OriginalURLs), expectedCount)
			}
			for index, original := range saved.OriginalURLs {
				expectedKey := saved.StorageKey
				if mode == "multiple" {
					expectedKey = saved.ImageStorage[index].StorageKey
				}
				if !strings.HasPrefix(original, "server:") || original != expectedKey {
					t.Errorf("array original not compacted: bytes=%d", len(original))
				}
			}
			row, _ := json.Marshal(saved)
			t.Logf("stored row bytes=%d original references=%d new uploads=%d", len(row), len(saved.OriginalURLs), uploads)
			if len(row) >= 100<<10 || strings.Contains(string(row), "base64") {
				t.Errorf("task row retains large inline content: bytes=%d", len(row))
			}
			if mode == "inline" && (uploads != 1 || saved.Width != 3840 || saved.Height != 2160) {
				t.Errorf("4K image uploaded more than once or dimensions lost: uploads=%d dimensions=%dx%d", uploads, saved.Width, saved.Height)
			}
			if mode == "duplicate" && uploads != 0 {
				t.Errorf("existing storage key uploaded again: uploads=%d", uploads)
			}
			if mode == "multiple" {
				response := service.CanvasImageTaskResponse(saved)
				responseURLs, _ := response["image_urls"].([]string)
				responseStorage, _ := response["imageStorage"].([]*model.CanvasImageStorage)
				if len(responseURLs) != 2 || len(responseStorage) != 2 {
					t.Error("multi-image response lost stable images")
				}
				var archive model.CanvasImageTaskResult
				if err := database.First(&archive, "user_id = ? AND task_id = ?", user.ID, saved.ID).Error; err != nil {
					t.Fatal(err)
				}
				var archived model.CanvasImageTask
				if err := json.Unmarshal([]byte(archive.ResultJSON), &archived); err != nil {
					t.Fatal(err)
				}
				if len(archived.ImageURLs) != 2 || len(archived.ImageStorage) != 2 || strings.Join(archived.ImageURLs, ",") != strings.Join(saved.ImageURLs, ",") || archived.ImageStorage[1].StorageKey != saved.ImageStorage[1].StorageKey || strings.Contains(archive.ResultJSON, "base64") {
					t.Error("durable result archive lost stable images or retained inline data")
				}
				if err := repository.DeleteFinishedCanvasImageTasksBefore(time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)); err != nil {
					t.Fatal(err)
				}
				var activeCount int64
				database.Model(&model.CanvasImageTask{}).Where("id = ?", saved.ID).Count(&activeCount)
				recovered, found, err := service.GetUserCanvasImageTask(user.ID, saved.ID)
				if err != nil || !found || activeCount != 0 || len(recovered.ImageURLs) != 2 || len(recovered.ImageStorage) != 2 || strings.Join(recovered.ImageURLs, ",") != strings.Join(saved.ImageURLs, ",") {
					t.Errorf("retention lost durable multiple results: active=%d found=%v images=%d err=%v", activeCount, found, len(recovered.ImageURLs), err)
				}
			}
		})
	}
}
