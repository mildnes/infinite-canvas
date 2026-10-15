package service

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

func TestMigrateUserImageGenerationLogsPreservesImageHistory(t *testing.T) {
	if os.Getenv("IC_IMAGE_LOG_MIGRATION") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestMigrateUserImageGenerationLogsPreservesImageHistory$", "-test.v")
		command.Env = append(os.Environ(), "IC_IMAGE_LOG_MIGRATION=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("image log migration: %v\n%s", err, output)
		}
		t.Logf("%s", output)
		return
	}
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "migration.db")
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	const legacyLog = `{"id":"legacy-log","status":"成功","createdAt":"2026-10-14T00:00:00Z","categoryIds":["manual"],"images":[{"storageKey":"server:existing"}]}`
	const metadata = `"categories":[{"id":"manual","name":"手动分类","createdAt":1,"updatedAt":2}],"deletedCategories":[{"id":"deleted","deletedAt":3}],"unknown":{"integer":9007199254740993,"enabled":true}`
	for _, sample := range []struct {
		name      string
		history   string
		remaining string
		logCount  int64
		unchanged bool
	}{
		{name: "empty logs preserve categories tombstones and unknown fields", history: `{"logs":[],` + metadata + `}`, remaining: `{` + metadata + `}`},
		{name: "legacy log migrates while category metadata survives", history: `{"logs":[` + legacyLog + `],` + metadata + `}`, remaining: `{` + metadata + `}`, logCount: 1},
		{name: "only legacy logs leave an empty blob", history: `{"logs":[` + legacyLog + `]}`, logCount: 1},
		{name: "empty logs alone leave an empty blob", history: `{"logs":[]}`},
		{name: "no logs key is a read only no op", history: `{` + metadata + `}`, unchanged: true},
		{name: "empty object is a read only no op", history: `{}`, unchanged: true},
		{name: "invalid JSON survives", history: `{"categories":[`, unchanged: true},
		{name: "array survives", history: `[{"id":"manual"}]`, unchanged: true},
		{name: "string survives", history: `"original"`, unchanged: true},
		{name: "null survives", history: `null`, unchanged: true},
		{name: "logs object survives", history: `{"logs":{},` + metadata + `}`, unchanged: true},
		{name: "logs string survives", history: `{"logs":"unexpected",` + metadata + `}`, unchanged: true},
	} {
		t.Run(sample.name, func(t *testing.T) {
			owner := sample.name
			t.Cleanup(func() { database.Where("user_id = ?", owner).Delete(&model.ImageGenerationLog{}) })
			const stamp = "2026-10-01T00:00:00Z"
			original := model.UserConfig{UserID: owner, ImageHistory: sample.history, ModelConfig: `{"untouched":true}`, CreatedAt: stamp, UpdatedAt: stamp}
			if err := database.Create(&original).Error; err != nil {
				t.Fatal(err)
			}
			if err := migrateUserImageGenerationLogs(owner); err != nil {
				t.Fatal(err)
			}
			saved, found, err := repository.GetUserConfig(owner)
			if err != nil || !found {
				t.Fatalf("read migrated config: found=%v err=%v", found, err)
			}
			if sample.unchanged {
				if saved.ImageHistory != sample.history || saved.UpdatedAt != stamp {
					t.Errorf("read-only migration changed image history or updated_at: history=%q updated_at=%q", saved.ImageHistory, saved.UpdatedAt)
				}
			} else if sample.remaining == "" {
				if saved.ImageHistory != "" {
					t.Errorf("only logs should leave an empty blob, got %q", saved.ImageHistory)
				}
			} else {
				assertImageHistoryFields(t, saved.ImageHistory, sample.remaining)
			}
			if saved.ModelConfig != original.ModelConfig || saved.CreatedAt != original.CreatedAt {
				t.Errorf("migration changed unrelated user configuration: %+v", saved)
			}
			var count int64
			if err := database.Model(&model.ImageGenerationLog{}).Where("user_id = ?", owner).Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			if count != sample.logCount {
				t.Fatalf("migrated %d logs, want %d", count, sample.logCount)
			}
			if sample.logCount > 0 {
				log, err := repository.GetImageGenerationLog(owner, "legacy-log")
				if err != nil {
					t.Fatal(err)
				}
				if log.PayloadJSON != legacyLog || log.SummaryJSON == "" {
					t.Errorf("legacy payload or summary not migrated: %+v", log)
				}
			}
			if err := migrateUserImageGenerationLogs(owner); err != nil {
				t.Fatal(err)
			}
			again, _, err := repository.GetUserConfig(owner)
			if err != nil {
				t.Fatal(err)
			}
			if again.ImageHistory != saved.ImageHistory || again.UpdatedAt != saved.UpdatedAt {
				t.Errorf("repeated migration was not a read-only no op: first=%+v again=%+v", saved, again)
			}
		})
	}

	t.Run("repeated paging preserves synced category definitions", func(t *testing.T) {
		const owner = "paging-owner"
		t.Cleanup(func() { database.Where("user_id = ?", owner).Delete(&model.ImageGenerationLog{}) })
		const stamp = "2026-10-01T00:00:00Z"
		history := `{"logs":[` + legacyLog + `],` + metadata + `}`
		if err := database.Create(&model.UserConfig{UserID: owner, ImageHistory: history, CreatedAt: stamp, UpdatedAt: stamp}).Error; err != nil {
			t.Fatal(err)
		}
		ctx := WithUser(context.Background(), model.AuthUser{ID: owner})
		for i := 0; i < 2; i++ {
			page, err := CurrentUserImageGenerationLogPage(ctx, 40, "")
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Items) != 1 {
				t.Fatalf("page %d returned %d logs, want 1", i+1, len(page.Items))
			}
			saved, _, err := repository.GetUserConfig(owner)
			if err != nil {
				t.Fatal(err)
			}
			assertImageHistoryFields(t, saved.ImageHistory, `{`+metadata+`}`)
		}
	})

	t.Run("failed log insert preserves original blob", func(t *testing.T) {
		const owner = "write-failure"
		history := `{"logs":[` + legacyLog + `],` + metadata + `}`
		original := model.UserConfig{UserID: owner, ImageHistory: history, UpdatedAt: "2026-10-01T00:00:00Z"}
		if err := database.Create(&original).Error; err != nil {
			t.Fatal(err)
		}
		if err := database.Exec(`CREATE TRIGGER reject_migration_log BEFORE INSERT ON image_generation_logs WHEN NEW.user_id = 'write-failure' BEGIN SELECT RAISE(FAIL, 'injected migration insert failure'); END`).Error; err != nil {
			t.Fatal(err)
		}
		if err := migrateUserImageGenerationLogs(owner); err == nil {
			t.Fatal("expected injected log insertion error")
		}
		saved, _, err := repository.GetUserConfig(owner)
		if err != nil {
			t.Fatal(err)
		}
		if saved.ImageHistory != original.ImageHistory || saved.UpdatedAt != original.UpdatedAt {
			t.Errorf("failed migration changed original blob: %+v", saved)
		}
	})

	for _, changeHistory := range []bool{true, false} {
		name := "concurrent model config update survives migration"
		if changeHistory {
			name = "concurrent category update survives migration"
		}
		t.Run(name, func(t *testing.T) {
			owner := name
			t.Cleanup(func() { database.Where("user_id = ?", owner).Delete(&model.ImageGenerationLog{}) })
			history := `{"logs":[` + legacyLog + `],` + metadata + `}`
			freshHistory := `{"logs":[` + legacyLog + `],"categories":[{"id":"fresh","name":"迁移期间新分类","createdAt":4}],"deletedCategories":[{"id":"manual","deletedAt":5}]}`
			const freshModelConfig = `{"channel":"changed-during-migration"}`
			const freshStamp = "2026-10-15T00:00:00Z"
			if err := database.Create(&model.UserConfig{UserID: owner, ImageHistory: history, ModelConfig: `{"channel":"old"}`, UpdatedAt: "2026-10-01T00:00:00Z"}).Error; err != nil {
				t.Fatal(err)
			}
			callbackName := "test:migration concurrent update"
			if err := database.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
				if tx.Statement.Table != "image_generation_logs" {
					return
				}
				query := `UPDATE user_configs SET model_config = ?, updated_at = ? WHERE user_id = ?`
				value := freshModelConfig
				if changeHistory {
					query = `UPDATE user_configs SET image_history = ?, updated_at = ? WHERE user_id = ?`
					value = freshHistory
				}
				tx.AddError(tx.Session(&gorm.Session{NewDB: true}).Exec(query, value, freshStamp, owner).Error)
			}); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { database.Callback().Create().Remove(callbackName) })
			if err := migrateUserImageGenerationLogs(owner); err != nil {
				t.Fatal(err)
			}
			saved, _, err := repository.GetUserConfig(owner)
			if err != nil {
				t.Fatal(err)
			}
			if changeHistory {
				if saved.ImageHistory != freshHistory || saved.UpdatedAt != freshStamp {
					t.Errorf("migration overwrote categories saved after its read: got=%+v want history=%s updated_at=%s", saved, freshHistory, freshStamp)
				}
			} else {
				if saved.ModelConfig != freshModelConfig {
					t.Errorf("migration overwrote concurrent model config: got=%s want=%s", saved.ModelConfig, freshModelConfig)
				}
				assertImageHistoryFields(t, saved.ImageHistory, `{`+metadata+`}`)
			}
		})
	}
}

func assertImageHistoryFields(t *testing.T, actual, expected string) {
	t.Helper()
	var actualFields, expectedFields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(actual), &actualFields); err != nil {
		t.Fatalf("category metadata was removed or corrupted: %q (%v)", actual, err)
	}
	if err := json.Unmarshal([]byte(expected), &expectedFields); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actualFields, expectedFields) {
		t.Errorf("migration must remove only logs and preserve other fields: got=%s want=%s", actual, expected)
	}
}
