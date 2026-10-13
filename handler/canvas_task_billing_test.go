package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
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

// Exercise the actual create -> runner -> proxy -> upstream chain, using an
// isolated SQLite database and localhost provider. No production or paid API.
func TestCanvasTaskBillingSingleAuthority(t *testing.T) {
	if os.Getenv("IC_BILLING_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestCanvasTaskBillingSingleAuthority$", "-test.v")
		command.Env = append(os.Environ(), "IC_BILLING_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("billing fixture: %v\n%s", err, output)
		}
		return
	}
	root := t.TempDir()
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(root, "billing.db")
	config.Cfg.AILogDir = filepath.Join(root, "logs")
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	imageResult := "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageBytes.Bytes())
	wav := make([]byte, 46) // One PCM sample, not a truncated audio fixture.
	copy(wav, "RIFF")
	binary.LittleEndian.PutUint32(wav[4:], 38)
	copy(wav[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(wav[16:], 16)
	binary.LittleEndian.PutUint16(wav[20:], 1)
	binary.LittleEndian.PutUint16(wav[22:], 1)
	binary.LittleEndian.PutUint32(wav[24:], 8000)
	binary.LittleEndian.PutUint32(wav[28:], 16000)
	binary.LittleEndian.PutUint16(wav[32:], 2)
	binary.LittleEndian.PutUint16(wav[34:], 16)
	copy(wav[36:], "data")
	binary.LittleEndian.PutUint32(wav[40:], 2)
	entered, cancelled := make(chan struct{}, 1), make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
			if err := r.ParseMultipartForm(32 << 20); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			defer r.MultipartForm.RemoveAll()
			body = map[string]any{"prompt": r.FormValue("prompt")}
		} else {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		mode := firstNonEmpty(fmt.Sprint(body["prompt"]), fmt.Sprint(body["input"]))
		if r.URL.Path == "/v1/audio/speech" {
			mode = fmt.Sprint(body["input"])
		}
		if mode == "stop" {
			entered <- struct{}{}
			select {
			case <-r.Context().Done():
				cancelled <- struct{}{}
			case <-time.After(5 * time.Second):
				http.Error(w, "fixture timed out", 500)
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if mode == "http-failure" {
			w.WriteHeader(502)
			_, _ = io.WriteString(w, `{"error":{"message":"fixture failure"}}`)
			return
		}
		if mode == "wrapped-failure" {
			_, _ = io.WriteString(w, `{"code":1,"msg":"fixture failure"}`)
			return
		}
		if r.URL.Path == "/v1/audio/speech" {
			w.Header().Set("Content-Type", "audio/wav")
			_, _ = w.Write(wav)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"url": imageResult}}})
	}))
	defer upstream.Close()
	const channelID = "billing"
	settings := model.Settings{}
	settings.Private.Channels = []model.ModelChannel{{ID: channelID, Protocol: "openai", Enabled: true, APIKey: "fixture", BaseURL: upstream.URL, Models: []string{"gpt-image-2", "tts"}}}
	settings.Public.ModelChannel.AvailableModels = []string{"gpt-image-2", "tts"}
	settings.Public.ModelChannel.ModelCosts = []model.ModelCost{{ChannelID: channelID, Model: "gpt-image-2", Credits: 7}, {ChannelID: channelID, Model: "tts", Credits: 7}}
	if _, err = repository.SaveSettings(settings, "now"); err != nil {
		t.Fatal(err)
	}
	newUser := func(t *testing.T) model.AuthUser {
		t.Helper()
		id := strings.ReplaceAll(t.Name(), "/", "-")
		if err := db.Create(&model.User{ID: id, Username: id, AffCode: id, Credits: 1000, Role: model.UserRoleAdmin}).Error; err != nil {
			t.Fatal(err)
		}
		return model.AuthUser{ID: id, Role: model.UserRoleAdmin}
	}
	assertLedger := func(t *testing.T, user model.AuthUser, consumeCount, refundCount int, amount float64) {
		t.Helper()
		var logs []model.CreditLog
		if err := db.Where("user_id = ?", user.ID).Find(&logs).Error; err != nil {
			t.Fatal(err)
		}
		consumes, refunds := 0, 0
		var delta float64
		for _, entry := range logs {
			delta += entry.Amount
			switch entry.Type {
			case model.CreditLogTypeAIConsume:
				consumes++
				if entry.Amount != -amount {
					t.Errorf("consume amount=%g want=%g", entry.Amount, -amount)
				}
			case model.CreditLogTypeAIRefund:
				refunds++
				if entry.Amount != amount {
					t.Errorf("refund amount=%g want=%g", entry.Amount, amount)
				}
			}
		}
		var saved model.User
		db.First(&saved, "id = ?", user.ID)
		t.Logf("consume=%d refund=%d delta=%g balance=%g", consumes, refunds, delta, saved.Credits)
		if consumes != consumeCount || refunds != refundCount || saved.Credits != 1000-float64(consumeCount)*amount+float64(refundCount)*amount {
			t.Errorf("ledger: consume=%d refund=%d delta=%g balance=%g; want consume=%d refund=%d balance=%g", consumes, refunds, delta, saved.Credits, consumeCount, refundCount, 1000-float64(consumeCount)*amount+float64(refundCount)*amount)
		}
	}
	assertAILog := func(t *testing.T, user model.AuthUser, credits float64) {
		t.Helper()
		files, err := os.ReadDir(config.Cfg.AILogDir)
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range files {
			data, err := os.ReadFile(filepath.Join(config.Cfg.AILogDir, file.Name()))
			if err != nil {
				t.Fatal(err)
			}
			for _, line := range bytes.Split(data, []byte("\n")) {
				var entry model.AICallLog
				if json.Unmarshal(line, &entry) == nil && entry.UserID == user.ID {
					if entry.Credits != credits {
						t.Fatalf("AI log credits=%g want=%g", entry.Credits, credits)
					}
					return
				}
			}
		}
		t.Fatal("proxy AI log missing")
	}
	requestBody := func(kind, mode string, n int) ([]byte, string, string) {
		modelName, endpoint := "gpt-image-2", "/images/generations"
		if kind == "audio" {
			modelName, endpoint = "tts", "/audio/speech"
		}
		data := map[string]any{"model": modelName, "prompt": mode, "input": mode}
		if n > 0 {
			data["n"] = n
		}
		body, _ := json.Marshal(data)
		return body, modelName, endpoint
	}
	for _, kind := range []string{"image", "audio"} {
		for _, mode := range []string{"success", "http-failure", "wrapped-failure", "stop", "user-channel"} {
			t.Run(kind+"/"+mode, func(t *testing.T) {
				user := newUser(t)
				body, modelName, endpoint := requestBody(kind, mode, 0)
				credits, userChannelID := 7.0, ""
				if mode == "user-channel" {
					credits, userChannelID = 0, "own"
					encoded, _ := json.Marshal(map[string]any{"localChannels": []map[string]any{{"id": "own", "protocol": "openai", "baseUrl": upstream.URL, "apiKey": "fixture", "models": []string{modelName}}}})
					if _, err := repository.SaveUserConfig(model.UserConfig{UserID: user.ID, ModelConfig: string(encoded)}); err != nil {
						t.Fatal(err)
					}
				}
				id := "client_" + kind + "_task_" + user.ID
				done := make(chan struct{})
				if kind == "image" {
					task, err := service.CreateCanvasImageTask(service.CanvasImageTaskCreateInput{UserID: user.ID, ClientTaskID: id, Model: modelName, ChannelID: channelID, UserChannelID: userChannelID, Credits: credits, BillingName: modelName, BillingPath: endpoint, Endpoint: endpoint})
					if err != nil {
						t.Fatal(err)
					}
					go func() {
						defer close(done)
						runCanvasImageTask(task, user, body, "application/json", channelID, userChannelID, modelName)
					}()
				} else {
					task, err := service.CreateCanvasAudioTask(service.CanvasAudioTaskCreateInput{UserID: user.ID, ClientTaskID: id, Model: modelName, ChannelID: channelID, UserChannelID: userChannelID, Credits: credits, BillingName: modelName, BillingPath: endpoint, Endpoint: endpoint})
					if err != nil {
						t.Fatal(err)
					}
					go func() {
						defer close(done)
						runCanvasAudioTask(task, user, body, "application/json", channelID, userChannelID)
					}()
				}
				if mode == "stop" {
					select {
					case <-entered:
					case <-time.After(3 * time.Second):
						t.Fatal("upstream not reached")
					}
					for i := 0; i < 2; i++ {
						if status, _, _, err := service.StopCanvasTask(kind, user.ID, id); err != nil || status != "cancelled" {
							t.Fatalf("stop status=%s err=%v", status, err)
						}
					}
					select {
					case <-cancelled:
					case <-time.After(2 * time.Second):
						t.Fatal("upstream not cancelled")
					}
				}
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Fatal("task did not finish")
				}
				var status string
				if kind == "image" {
					task, _, _ := service.GetUserCanvasImageTask(user.ID, id)
					status = task.Status
				} else {
					task, _, _ := service.GetUserCanvasAudioTask(user.ID, id)
					status = task.Status
				}
				wantStatus := "completed"
				refund := 0
				if strings.Contains(mode, "failure") {
					wantStatus, refund = "failed", 1
				}
				if mode == "stop" {
					wantStatus, refund = "cancelled", 1
				}
				if status != wantStatus {
					t.Errorf("task status=%s want=%s", status, wantStatus)
				}
				if mode == "user-channel" {
					assertLedger(t, user, 0, 0, 0)
				} else {
					assertLedger(t, user, 1, refund, 7)
				}
				assertAILog(t, user, credits)
			})
		}
		for _, multipartRequest := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/http-create-n3-multipart-%v", kind, multipartRequest), func(t *testing.T) {
				user := newUser(t)
				body, _, endpoint := requestBody(kind, "success", 3)
				id := "client_" + kind + "_task_" + user.ID
				wrapper, _ := json.Marshal(map[string]any{"endpoint": endpoint, "clientTaskId": id, "request": json.RawMessage(body)})
				contentType := "application/json"
				if multipartRequest {
					var encoded bytes.Buffer
					writer := multipart.NewWriter(&encoded)
					for key, value := range map[string]string{"model": map[string]string{"image": "gpt-image-2", "audio": "tts"}[kind], "n": "3", "prompt": "success", "input": "success", "_canvas_task_id": id, "_canvas_endpoint": endpoint} {
						if err := writer.WriteField(key, value); err != nil {
							t.Fatal(err)
						}
					}
					writer.Close()
					wrapper, contentType = encoded.Bytes(), writer.FormDataContentType()
				}
				r := httptest.NewRequest(http.MethodPost, "/api/v1/canvas/"+kind+"-tasks", bytes.NewReader(wrapper)).WithContext(service.WithUser(context.Background(), user))
				r.Header.Set("Content-Type", contentType)
				r.Header.Set("X-Model-Channel-ID", channelID)
				w := httptest.NewRecorder()
				if kind == "image" {
					CreateCanvasImageTask(w, r)
				} else {
					CreateCanvasAudioTask(w, r)
				}
				var response struct {
					Code int
					Data struct{ ID string }
				}
				if json.Unmarshal(w.Body.Bytes(), &response) != nil || response.Code != 0 || response.Data.ID != id {
					t.Fatalf("create: %s", w.Body)
				}
				deadline := time.Now().Add(5 * time.Second)
				for {
					status := ""
					if kind == "image" {
						task, _, _ := service.GetUserCanvasImageTask(user.ID, id)
						status = task.Status
					} else {
						task, _, _ := service.GetUserCanvasAudioTask(user.ID, id)
						status = task.Status
					}
					if status == "completed" {
						break
					}
					if status == "failed" || time.Now().After(deadline) {
						t.Fatalf("task status %s", status)
					}
					time.Sleep(10 * time.Millisecond)
				}
				assertLedger(t, user, 1, 0, 21)
				assertAILog(t, user, 21)
			})
		}
		for _, mode := range []string{"success", "http-failure"} {
			t.Run("public-proxy/"+kind+"/"+mode, func(t *testing.T) {
				user := newUser(t)
				body, _, endpoint := requestBody(kind, mode, 3)
				r := httptest.NewRequest(http.MethodPost, "/api/ai"+endpoint, bytes.NewReader(body)).WithContext(service.WithUser(context.Background(), user))
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("X-Model-Channel-ID", channelID)
				proxyAIRequest(httptest.NewRecorder(), r, endpoint)
				refund := 0
				if mode == "http-failure" {
					refund = 1
				}
				assertLedger(t, user, 1, refund, 21)
				assertAILog(t, user, 21)
			})
		}
	}
}
