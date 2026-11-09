package handler

import (
	"encoding/json"
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

func TestCanvasRevisedPromptSurvivesTaskPersistence(t *testing.T) {
	if os.Getenv("IC_REVISED_PROMPT_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestCanvasRevisedPromptSurvivesTaskPersistence$", "-test.v")
		command.Env = append(os.Environ(), "IC_REVISED_PROMPT_FIXTURE=1")
		output, err := command.CombinedOutput()
		t.Logf("%s", output)
		if err != nil {
			t.Fatalf("revised prompt fixture: %v", err)
		}
		return
	}
	root := t.TempDir()
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(root, "revised.db")
	config.Cfg.AILogDir = filepath.Join(root, "logs")
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	revisions := map[string]any{"different": "模型改写后的提示词", "same": "same", "wrong_type": 123}
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var input struct{ Prompt string }
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		item := map[string]any{"b64_json": png}
		if revised, found := revisions[input.Prompt]; found {
			item["revised_prompt"] = revised
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"data": []any{item}})
	}))
	defer upstream.Close()
	settings := model.Settings{}
	settings.Private.Channels = []model.ModelChannel{{ID: "revised", Protocol: "openai", BaseURL: upstream.URL, APIKey: "fixture", Models: []string{"gpt-image-2.6-flare"}, Enabled: true}}
	settings.Public.ModelChannel.AvailableModels = []string{"gpt-image-2.6-flare"}
	if _, err := repository.SaveSettings(settings, "now"); err != nil {
		t.Fatal(err)
	}
	user := model.AuthUser{ID: "revised-owner", Role: model.UserRoleAdmin}
	for _, prompt := range []string{"different", "same", "missing", "wrong_type"} {
		t.Run(prompt, func(t *testing.T) {
			task, err := service.CreateCanvasImageTask(service.CanvasImageTaskCreateInput{
				UserID: user.ID, ClientTaskID: "revised-" + prompt, Model: "gpt-image-2.6-flare", ChannelID: "revised",
				Endpoint: "/images/generations", Prompt: prompt, RequestBody: `{"fixture":true}`,
				SourceID: "board", NodeID: "node-" + prompt,
			})
			if err != nil {
				t.Fatal(err)
			}
			body, _ := json.Marshal(map[string]string{"model": task.Model, "prompt": prompt})
			runCanvasImageTask(task, user, body, "application/json", task.ChannelID, "", task.Model)
			saved, found, err := service.GetUserCanvasImageTask(user.ID, task.ID)
			if err != nil || !found || saved.Status != "completed" || saved.Prompt != prompt {
				t.Fatalf("task/image/original prompt changed: status=%s prompt=%q err=%v", saved.Status, saved.Prompt, err)
			}
			response := service.CanvasImageTaskResponse(saved)
			want, valid := revisions[prompt].(string)
			if valid && response["revisedPrompt"] != want {
				t.Errorf("revisedPrompt actual=%v expected=%q after database reload", response["revisedPrompt"], want)
			}
			if !valid {
				if _, exists := response["revisedPrompt"]; exists {
					t.Error("missing or invalid revised_prompt must stay absent")
				}
			}
			if err := repository.DeleteFinishedCanvasImageTasksBefore("9999"); err != nil {
				t.Fatal(err)
			}
			archived, found, err := service.GetUserCanvasImageTask(user.ID, task.ID)
			if err != nil || !found || archived.ImageURL != saved.ImageURL {
				t.Fatalf("result archive recovery failed: found=%v err=%v", found, err)
			}
			if valid && service.CanvasImageTaskResponse(archived)["revisedPrompt"] != want {
				t.Error("revised prompt lost after terminal task retention cleanup")
			}
			database, err := repository.DB()
			if err != nil || database.Migrator().HasColumn(&model.CanvasImageTask{}, "revised_prompt") {
				t.Fatal("revised prompt must not create a database column", err)
			}
		})
	}
}
