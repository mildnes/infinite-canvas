package repository

import (
	"encoding/json"
	"sync"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestMigrateLegacyAgentSkillsPreservesMCPAndIsIdempotent(t *testing.T) {
	previousConfig := config.Cfg
	previousDB, previousErr, previousOnce := db, dbErr, dbOnce
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = t.TempDir() + "/skills.db"
	db, dbErr, dbOnce = nil, nil, sync.Once{}
	t.Cleanup(func() {
		config.Cfg = previousConfig
		db, dbErr, dbOnce = previousDB, previousErr, previousOnce
	})

	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	private := model.PrivateSetting{Agent: model.PrivateAgentSetting{
		Skills:     []model.LegacyAgentSkill{{ID: "old", Name: "旧 Skill", Prompt: "旧内容", Enabled: true}},
		MCPServers: []model.MCPServer{{ID: "mcp", Name: "保留", Transport: "stdio", Command: "cat"}},
	}}
	value, _ := json.Marshal(private)
	if err := database.Create(&model.Setting{Key: model.SettingKeyPrivate, Value: value, CreatedAt: "old", UpdatedAt: "old"}).Error; err != nil {
		t.Fatal(err)
	}

	item := model.AgentSkill{ID: "migrated", Source: model.AgentSkillSourceSystem, Name: "旧 Skill", Content: "旧内容", Enabled: true, CreatedAt: "now", UpdatedAt: "now"}
	migrated, err := MigrateLegacyAgentSkills([]model.AgentSkill{item}, "now", "v0.6.0")
	if err != nil || !migrated {
		t.Fatalf("first migration = %v, %v", migrated, err)
	}
	settings, err := GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.Private.Agent.Skills) != 0 || len(settings.Private.Agent.MCPServers) != 1 || settings.Private.Agent.MCPServers[0].ID != "mcp" {
		t.Fatalf("private agent setting = %#v", settings.Private.Agent)
	}
	if saved, found, err := GetAgentSkill("migrated"); err != nil || !found || saved.Content != "旧内容" {
		t.Fatalf("migrated skill = %#v, %v, %v", saved, found, err)
	}

	repeated, err := MigrateLegacyAgentSkills([]model.AgentSkill{{ID: "unexpected", Source: model.AgentSkillSourceSystem}}, "later", "v0.6.0")
	if err != nil || repeated {
		t.Fatalf("second migration = %v, %v", repeated, err)
	}
	if _, found, err := GetAgentSkill("unexpected"); err != nil || found {
		t.Fatalf("unexpected skill found = %v, %v", found, err)
	}
}
