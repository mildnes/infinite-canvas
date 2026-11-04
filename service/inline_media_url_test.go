package service

import (
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
	"gorm.io/gorm"
)

func TestNormalizeInlineMediaURLStoredReferences(t *testing.T) {
	source := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("already-persisted"))
	for _, sample := range []struct {
		source, key, expected string
		wantError             bool
	}{
		{source, "server:known-object", "server:known-object", false},
		{source, "", "", true},
		{source, "image:local", "", true},
		{"https://example.com/a.png", "server:known-object", "https://example.com/a.png", false},
		{"http://example.com/a.png", "", "http://example.com/a.png", false},
		{"server:existing", "", "server:existing", false},
		{"image:existing", "", "image:existing", false},
		{"", "", "", false},
	} {
		normalized, err := NormalizeInlineMediaURL("owner", sample.source, sample.key)
		if normalized != sample.expected || (err != nil) != sample.wantError {
			t.Errorf("normalize sourceBytes=%d key=%q: got=%q err=%v", len(sample.source), sample.key, normalized, err)
		}
		if strings.HasPrefix(normalized, "data:") {
			t.Error("inline media escaped normalization")
		}
	}
	for _, malformed := range []string{"data:image/png", "data:image/png;base64,%%%", "data:image/png;base64,"} {
		if normalized, err := NormalizeInlineMediaURL("owner", malformed); normalized != "" || err == nil {
			t.Errorf("malformed inline returned a reference: %q %v", normalized, err)
		}
	}
}

func TestCompactInlineMediaURLNeverUploadsAndNeverWrites(t *testing.T) {
	if os.Getenv("IC_COMPACT_INLINE_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestCompactInlineMediaURLNeverUploadsAndNeverWrites$", "-test.v")
		command.Env = append(os.Environ(), "IC_COMPACT_INLINE_FIXTURE=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("compact inline fixture: %v\n%s", err, output)
		}
		t.Logf("%s", output)
		return
	}
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "compact.db")
	config.Cfg.AILogDir = t.TempDir()
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("existing-compact-content")
	hash := sha256.Sum256(content)
	object := model.StorageObject{ID: "compact-existing", ObjectKey: "compact-existing.png", ProviderID: generatedMediaProviderID, CreatedBy: "owner", Bytes: int64(len(content)), SHA256: hex.EncodeToString(hash[:])}
	if _, err := repository.SaveStorageObject(object); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(GeneratedMediaDir(), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(GeneratedMediaDir(), object.ObjectKey), content, 0600); err != nil {
		t.Fatal(err)
	}
	source := "data:image/png;base64," + base64.StdEncoding.EncodeToString(content)
	before, err := json.Marshal(map[string]any{"id": "log", "task": map[string]any{"originalUrl": source}})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&model.ImageGenerationLog{ID: "log", UserID: "owner", PayloadJSON: string(before)}).Error; err != nil {
		t.Fatal(err)
	}
	var writes int
	const callback = "compact-write-guard"
	if err := database.Callback().Create().Before("gorm:create").Register(callback, func(tx *gorm.DB) {
		writes++
	}); err != nil {
		t.Fatal(err)
	}
	defer database.Callback().Create().Remove(callback)
	compactImageLogOriginalURLs("owner", before)
	after, err := repository.GetImageGenerationLog("owner", "log")
	if err != nil || after.PayloadJSON != string(before) || writes != 0 {
		t.Fatalf("history read/compaction wrote data: writes=%d err=%v", writes, err)
	}
	if CompactInlineMediaURL("owner", source) != "/api/files/compact-existing/content" {
		t.Fatal("compact helper did not reuse verified object")
	}
	if got := CompactInlineMediaURL("other", source); got != "/api/files/compact-existing/content" {
		t.Fatalf("equivalent Base64 cross-account reference was rejected: %s", got)
	}
}
