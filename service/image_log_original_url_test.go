package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestImageLogsCompactEquivalentOriginals(t *testing.T) {
	if os.Getenv("IC_IMAGE_LOG_COMPACTION") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestImageLogsCompactEquivalentOriginals$", "-test.v")
		command.Env = append(os.Environ(), "IC_IMAGE_LOG_COMPACTION=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("image log compaction: %v\n%s", err, output)
		}
		t.Logf("%s", output)
		return
	}
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "logs.db")
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(GeneratedMediaDir(), 0700); err != nil {
		t.Fatal(err)
	}
	ctx := WithUser(context.Background(), model.AuthUser{ID: "owner"})
	inline := func(data string) string {
		return "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte(data))
	}
	for _, sample := range []struct {
		id, content, actual, owner, deleted string
	}{
		{"match escaped", "equivalent", "equivalent", "owner", ""},
		{"foreign", "foreign-content", "foreign-content", "other-owner", ""},
		{"unreadable", "missing-file", "", "owner", ""},
		{"corrupt", "expected-content", "wrong-content", "owner", ""},
		{"deleted", "deleted-content", "deleted-content", "owner", "deleted"},
	} {
		sum := sha256.Sum256([]byte(sample.content))
		object := model.StorageObject{
			ID: sample.id, ObjectKey: strings.ReplaceAll(sample.id, "/", "-") + ".png",
			ProviderID: generatedMediaProviderID, CreatedBy: sample.owner, DeletedAt: sample.deleted,
			Bytes: int64(len(sample.content)), SHA256: strings.ToUpper(hex.EncodeToString(sum[:])),
		}
		if _, err := repository.SaveStorageObject(object); err != nil {
			t.Fatal(err)
		}
		if sample.actual != "" {
			if err := os.WriteFile(filepath.Join(GeneratedMediaDir(), object.ObjectKey), []byte(sample.actual), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	data := func(id string) json.RawMessage {
		raw, err := json.Marshal(map[string]any{
			"id": id, "status": "成功", "images": []any{},
			"task": map[string]any{
				"id": "task-" + id, "originalUrl": inline("equivalent"),
				"originalUrls": []any{inline("equivalent"), inline("foreign-content"), inline("unknown-content"), inline("missing-file"), inline("expected-content"), inline("deleted-content"), "data:image/png;base64,%%%", "/api/files/keep/content", "server:keep", "https://images.example/keep.png"},
			},
			"custom": json.RawMessage("9007199254740993"),
		})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	verify := func(t *testing.T, raw string) {
		t.Helper()
		var record struct {
			Task struct {
				OriginalURL  string   `json:"originalUrl"`
				OriginalURLs []string `json:"originalUrls"`
			} `json:"task"`
		}
		if err := json.Unmarshal([]byte(raw), &record); err != nil {
			t.Fatal(err)
		}
		want := "/api/files/match%20escaped/content"
		if record.Task.OriginalURL != want || record.Task.OriginalURLs[0] != want || record.Task.OriginalURLs[1] != "/api/files/foreign/content" {
			t.Errorf("equivalent originals not compacted: %s", raw)
		}
		original := data("expected")
		var expected struct {
			Task struct{ OriginalURLs []string }
		}
		_ = json.Unmarshal(original, &expected)
		for i := 2; i < len(expected.Task.OriginalURLs); i++ {
			if record.Task.OriginalURLs[i] != expected.Task.OriginalURLs[i] {
				t.Errorf("unverifiable or non-data original %d changed", i)
			}
		}
		if !strings.Contains(raw, "9007199254740993") {
			t.Error("unrelated precision changed")
		}
	}
	t.Run("save", func(t *testing.T) {
		if _, err := SaveCurrentUserImageGenerationLogs(ctx, []json.RawMessage{data("save")}); err != nil {
			t.Fatal(err)
		}
		saved, err := repository.GetImageGenerationLog("owner", "save")
		if err != nil {
			t.Fatal(err)
		}
		verify(t, saved.PayloadJSON)
	})
	t.Run("upsert", func(t *testing.T) {
		if err := UpsertCurrentUserImageGenerationLogs(ctx, []json.RawMessage{data("upsert")}); err != nil {
			t.Fatal(err)
		}
		saved, err := repository.GetImageGenerationLog("owner", "upsert")
		if err != nil {
			t.Fatal(err)
		}
		verify(t, saved.PayloadJSON)
	})
	t.Run("list-without-database-write", func(t *testing.T) {
		original := data("legacy")
		if err := database.Create(&model.ImageGenerationLog{ID: "legacy", UserID: "owner", PayloadJSON: string(original), DeletedAt: ""}).Error; err != nil {
			t.Fatal(err)
		}
		logs, err := CurrentUserImageGenerationLogs(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, raw := range logs {
			verify(t, string(raw))
		}
		unchanged, err := repository.GetImageGenerationLog("owner", "legacy")
		if err != nil || unchanged.PayloadJSON != string(original) {
			t.Fatalf("read path changed stored payload: %v", err)
		}
	})
	t.Run("non-string-array-values-preserved", func(t *testing.T) {
		raw, _ := json.Marshal(map[string]any{
			"id": "mixed", "task": map[string]any{
				"originalUrls": []any{inline("equivalent"), nil, 42, map[string]string{"keep": "opaque"}},
			},
		})
		if err := UpsertCurrentUserImageGenerationLogs(ctx, []json.RawMessage{raw}); err != nil {
			t.Fatal(err)
		}
		saved, err := repository.GetImageGenerationLog("owner", "mixed")
		if err != nil {
			t.Fatal(err)
		}
		var root map[string]json.RawMessage
		_ = json.Unmarshal([]byte(saved.PayloadJSON), &root)
		var task map[string][]json.RawMessage
		_ = json.Unmarshal(root["task"], &task)
		if len(task["originalUrls"]) != 4 {
			t.Fatalf("array entries lost: %s", root["task"])
		}
		expected := []string{`"/api/files/match%20escaped/content"`, "null", "42", `{"keep":"opaque"}`}
		for i, value := range task["originalUrls"] {
			if string(value) != expected[i] {
				t.Fatalf("mixed original %d changed: %s", i, value)
			}
		}
	})
}
