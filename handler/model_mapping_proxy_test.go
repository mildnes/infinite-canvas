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
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

// Only a local HTTP fixture is contacted; no real provider requests or charges.
func TestProxyModelMappingKeepsLocalSelectionBillingAuditAndCanvasTask(t *testing.T) {
	// Repository uses a process singleton. Isolate this HTTP/DB fixture so it
	// cannot change another test's database or depend on execution order.
	if os.Getenv("IC_MODEL_MAPPING_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestProxyModelMappingKeepsLocalSelectionBillingAuditAndCanvasTask$", "-test.v")
		command.Env = append(os.Environ(), "IC_MODEL_MAPPING_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("isolated proxy fixture: %v\n%s", err, output)
		}
		return
	}
	previous := config.Cfg
	root := t.TempDir()
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(root, "mapping.db")
	config.Cfg.AILogDir = filepath.Join(root, "logs")
	t.Cleanup(func() { config.Cfg = previous })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var outgoing []map[string]any
	var paths []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.RequestURI())
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		outgoing = append(outgoing, payload)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/videos/generations" || r.URL.Path == "/v1/async-result/video-task" {
			_, _ = io.WriteString(w, "{\"id\":\"video-task\",\"status\":\"processing\"}")
			return
		}
		_, _ = io.WriteString(w, "{\"data\":[{\"url\":\"https://media.invalid/image.png\"}]}")
	}))
	defer upstream.Close()
	channel := model.ModelChannel{ID: "mapping", Protocol: "openai", Enabled: true, BaseURL: upstream.URL, APIKey: "fixture-key", Models: []string{"local"}, ModelMap: map[string]string{"local": "upstream"},
		ImageOutputCapabilities:  map[string]model.ImageOutputCapability{"local": {Formats: []model.ImageOutputFormat{model.ImageOutputFormatPNG}}},
		ImageQualityCapabilities: map[string]model.ImageQualityCapability{"local": {Values: []string{"high"}, Map: map[string]string{"best": "high"}}},
	}
	settings := model.Settings{}
	settings.Private.Channels = []model.ModelChannel{channel}
	settings.Public.ModelChannel.AvailableModels = []string{"local"}
	settings.Public.ModelChannel.ModelCosts = []model.ModelCost{{ChannelID: channel.ID, Model: "local", Credits: 3}, {ChannelID: channel.ID, Model: "upstream", Credits: 97}}
	if _, err = repository.SaveSettings(settings, "now"); err != nil {
		t.Fatal(err)
	}
	user := model.AuthUser{ID: "mapping-user", Role: model.UserRoleAdmin}
	if err = db.Create(&model.User{ID: user.ID, Username: user.ID, AffCode: "mapping-aff", Credits: 100}).Error; err != nil {
		t.Fatal(err)
	}
	body := []byte("{\"model\":\"local\",\"prompt\":\"local remains in prompt\",\"output_format\":\"png\",\"quality\":\"best\"}")
	r := httptest.NewRequest(http.MethodPost, "/api/v1/images/generations", bytes.NewReader(body)).WithContext(service.WithUser(context.Background(), user))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Model-Channel-ID", channel.ID)
	w := httptest.NewRecorder()
	proxyAIRequest(w, r, "/images/generations")
	if w.Code != http.StatusOK || len(outgoing) != 1 || outgoing[0]["model"] != "upstream" || outgoing[0]["quality"] != "high" || outgoing[0]["output_format"] != "png" || outgoing[0]["prompt"] != "local remains in prompt" {
		t.Fatalf("proxy did not map at outbound boundary: %d %s %+v", w.Code, w.Body, outgoing)
	}
	var savedUser model.User
	if err = db.First(&savedUser, "id = ?", user.ID).Error; err != nil || savedUser.Credits != 97 {
		t.Fatalf("billing used upstream name: %+v %v", savedUser, err)
	}
	var creditLogs []model.CreditLog
	if err = db.Find(&creditLogs).Error; err != nil || len(creditLogs) != 1 || !strings.Contains(creditLogs[0].Extra, "\"model\":\"local\"") {
		t.Fatalf("billing log lost local name: %+v %v", creditLogs, err)
	}
	files, _ := os.ReadDir(config.Cfg.AILogDir)
	loggedLocal := false
	for _, file := range files {
		data, _ := os.ReadFile(filepath.Join(config.Cfg.AILogDir, file.Name()))
		for _, line := range strings.Split(string(data), "\n") {
			var entry model.AICallLog
			if json.Unmarshal([]byte(line), &entry) == nil && entry.Model == "local" && entry.Credits == 3 {
				loggedLocal = true
			}
		}
	}
	if !loggedLocal {
		t.Fatal("audit model must remain local")
	}
	if _, err = service.SelectModelChannelForModel("upstream", channel.ID, true); err == nil {
		t.Fatal("upstream name became available for channel selection")
	}
	get := httptest.NewRequest(http.MethodGet, "/api/v1/tts/voices?model=local", nil).WithContext(service.WithUser(context.Background(), user))
	get.Header.Set("X-Model-Channel-ID", channel.ID)
	proxyAIGetRequest(httptest.NewRecorder(), get, "/tts/voices?model=local")
	if paths[1] != "/v1/tts/voices?model=upstream" {
		t.Fatalf("GET query was not mapped: %v", paths)
	}
	_, status, _, err := executeCanvasAIRequest(user, "/images/generations", body, "application/json", channel.ID, "")
	if err != nil || status != http.StatusOK || len(outgoing) != 3 || outgoing[2]["model"] != "upstream" {
		t.Fatalf("canvas request bypassed mapping: status=%d err=%v outgoing=%+v", status, err, outgoing)
	}
	if service.CanvasImageTaskResponse(model.CanvasImageTask{Model: "local"})["model"] != "local" {
		t.Fatal("canvas response model changed")
	}
	channel.Models = append(channel.Models, "local-video")
	channel.ModelMap["local-video"] = "cogvideox-3"
	settings.Private.Channels = []model.ModelChannel{channel}
	settings.Public.ModelChannel.AvailableModels = append(settings.Public.ModelChannel.AvailableModels, "local-video")
	if _, err = repository.SaveSettings(settings, "now"); err != nil {
		t.Fatal(err)
	}
	video := httptest.NewRequest(http.MethodPost, "/api/v1/videos", strings.NewReader("{\"model\":\"local-video\",\"prompt\":\"scene\"}")).WithContext(service.WithUser(context.Background(), user))
	video.Header.Set("Content-Type", "application/json")
	video.Header.Set("X-Model-Channel-ID", channel.ID)
	created := httptest.NewRecorder()
	proxyAIVideoTaskRequest(created, video)
	var response struct{ Data struct{ ID, Model string } }
	if json.Unmarshal(created.Body.Bytes(), &response) != nil || response.Data.ID == "" || response.Data.Model != "local-video" {
		t.Fatalf("mapped video creation failed: %s", created.Body)
	}
	if len(paths) != 4 || paths[3] != "/v1/videos/generations" || outgoing[3]["model"] != "cogvideox-3" {
		t.Fatalf("video create bypassed mapping: paths=%v bodies=%+v", paths, outgoing)
	}
	task, found, err := service.GetUserVideoTask(user.ID, response.Data.ID)
	if err != nil || !found || task.Model != "local-video" {
		t.Fatalf("video task lost local model: %+v %v", task, err)
	}
	if _, err = pollVideoTaskFromUpstream(task); err != nil {
		t.Fatal(err)
	}
	if len(paths) != 5 || paths[4] != "/v1/async-result/video-task" {
		t.Fatalf("video poll used local model for protocol path: %v", paths)
	}
}
