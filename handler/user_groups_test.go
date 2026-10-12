package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/middleware"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

// Run in a subprocess because repository.DB is a singleton. No production DB or provider calls.
func TestUserGroupsHTTPAndAccountLifecycle(t *testing.T) {
	if os.Getenv("IC_GROUP_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestUserGroupsHTTPAndAccountLifecycle$", "-test.v")
		command.Env = append(os.Environ(), "IC_GROUP_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("group fixture: %v\n%s", err, output)
		}
		return
	}
	root := t.TempDir()
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(root, "groups.db")
	config.Cfg.JWTSecret = "test-only-group-secret"
	config.Cfg.AILogDir = filepath.Join(root, "logs")
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	allow := true
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{{
		ID: "system", Enabled: true, Protocol: "openai", BaseURL: "https://fixture.invalid", APIKey: "fixture", Models: []string{"text", "gpt-image-visible", "hidden"},
		ModelMap:          map[string]string{"text": "upstream-text", "hidden": "private-upstream"},
		ModelCapabilities: map[string][]model.ModelCapability{"text": {model.ModelCapabilityText}, "gpt-image-visible": {model.ModelCapabilityImage}},
	}}}, Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{
		AllowUserRemoteChannel: &allow, AvailableModels: []string{"text", "gpt-image-visible"},
		UserGroups: []model.UserGroupSetting{{ID: "default", IsDefault: true, Unrestricted: true}, {ID: "vip", Models: []string{"text"}}, {ID: "empty"}},
	}}}
	if _, err = repository.SaveSettings(settings, "now"); err != nil {
		t.Fatal(err)
	}
	// Old admin clients omit userGroups; omission must preserve all saved groups.
	legacy := settings
	legacy.Private.Channels = append([]model.ModelChannel{}, settings.Private.Channels...)
	legacy.Public.ModelChannel.UserGroups = nil
	legacy.Public.ModelChannel.AvailableModels = nil
	restored, err := service.SaveSettings(legacy)
	if err != nil || len(restored.Public.ModelChannel.UserGroups) != 3 || len(restored.Public.ModelChannel.UserGroups[1].Models) != 1 {
		t.Fatalf("legacy settings erased groups: %+v %v", restored, err)
	}
	if settings.Private.Channels[0].APIKey != "fixture" {
		t.Fatal("legacy settings save mutated the original fixture key")
	}
	if _, err = repository.SaveSettings(settings, "now"); err != nil {
		t.Fatal(err)
	}
	for _, user := range []model.User{{ID: "a", Username: "a", Role: model.UserRoleAdmin, Status: model.UserStatusActive, AffCode: "a"}, {ID: "u", Username: "u", GroupID: "vip", Role: model.UserRoleUser, Status: model.UserStatusActive, AffCode: "u", Credits: 19}} {
		if err := db.Create(&user).Error; err != nil {
			t.Fatal(err)
		}
	}
	// Verify fresh DB-derived GroupID for every request, including unchanged tokens after regrouping.
	engine := gin.New()
	engine.GET("/settings", middleware.OptionalAuth, gin.WrapF(handler.Settings))
	for _, id := range []string{"a", "u", ""} {
		request := httptest.NewRequest(http.MethodGet, "/settings", nil)
		if id != "" {
			var user model.User
			if err = db.First(&user, "id = ?", id).Error; err != nil {
				t.Fatal(err)
			}
			token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{UserID: user.ID, Username: user.Username, Role: user.Role}).SignedString([]byte(config.Cfg.JWTSecret))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, request)
		var result struct {
			Code int
			Data model.PublicSetting
		}
		if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Code != 0 {
			t.Fatalf("settings %s", response.Body.String())
		}
		expected := 2
		if id == "u" {
			expected = 1
		}
		if len(result.Data.ModelChannel.AvailableModels) != expected {
			t.Fatalf("settings id=%s %+v", id, result.Data)
		}
		if len(result.Data.ModelChannel.UserGroups) != 0 {
			t.Fatal("public settings exposed group policies")
		}
		if response.Header().Get("Cache-Control") != "private, no-store" || response.Header().Get("Vary") != "Authorization" {
			t.Fatal("user settings may be cached across accounts")
		}
	}
	user := model.AuthUser{ID: "u", Role: model.UserRoleUser, GroupID: "vip"}
	ctx := service.WithUser(context.Background(), user)
	if _, err = service.SelectModelChannelForUser(ctx, "text", "system", true); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"gpt-image-visible", "hidden"} {
		if _, err = service.SelectModelChannelForUser(ctx, name, "system", true); err == nil {
			t.Fatal("group external model accepted")
		}
	}
	if _, err = service.SelectModelChannelForUser(ctx, "hidden", "system", false); err != nil {
		t.Fatal("internal task continuation changed", err)
	}
	unrestricted := service.WithUser(context.Background(), model.AuthUser{ID: "a", Role: model.UserRoleAdmin})
	if _, err = service.SelectModelChannelForUser(unrestricted, "hidden", "system", true); err == nil {
		t.Fatal("unrestricted group bypassed global visibility")
	}
	if _, err = service.SelectModelChannelForModel("hidden", "system", true); err == nil {
		t.Fatal("background call bypassed global visibility")
	}
	_, err = service.DraftCreativeWorkflow(ctx, service.WorkflowAgentDraftRequest{Model: "hidden", Prompt: "draft", ChannelMode: "remote"})
	if err == nil || !strings.Contains(err.Error(), "模型未开放") {
		t.Fatalf("draft bypassed group: %v", err)
	}
	// Full update accepts empty group ID without losing credits.
	saved, err := service.SaveUser(model.User{ID: "u", Username: "u", GroupID: "", Role: model.UserRoleUser, Status: model.UserStatusActive}, "")
	if err != nil || saved.GroupID != "" || saved.Credits != 19 {
		t.Fatalf("VIP -> default: %+v %v", saved, err)
	}
	if _, err = service.SetUserGroup("u", "vip"); err != nil {
		t.Fatal(err)
	}
	claims := service.TokenClaims{UserID: "u", Username: "u", Role: model.UserRoleUser}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(config.Cfg.JWTSecret))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetUserGroup("u", "empty"); err != nil {
		t.Fatal(err)
	}
	current, ok := service.CurrentAuthUser(token)
	if !ok || current.GroupID != "empty" {
		t.Fatal("unchanged token used stale group")
	}
	emptySettings, err := service.PublicSettingsForUser(current)
	if err != nil || len(emptySettings.ModelChannel.AvailableModels) != 0 || len(emptySettings.ModelChannel.Channels) != 0 {
		t.Fatalf("empty group: %+v %v", emptySettings, err)
	}
	if _, err = service.SetUserGroup("u", "vip"); err != nil {
		t.Fatal(err)
	}
	settings.Public.ModelChannel.UserGroups = settings.Public.ModelChannel.UserGroups[:1]
	if _, err = service.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	updated, _, err := repository.GetUserByID("u")
	if err != nil || updated.GroupID != "" {
		t.Fatalf("deleted group did not clear member: %+v %v", updated, err)
	}
	// Rollback both member changes and configuration if writing settings fails.
	settings.Public.ModelChannel.UserGroups = append(settings.Public.ModelChannel.UserGroups, model.UserGroupSetting{ID: "vip", Models: []string{"text"}})
	if _, err = repository.SaveSettings(settings, "now"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetUserGroup("u", "vip"); err != nil {
		t.Fatal(err)
	}
	if err = db.Exec("CREATE TRIGGER reject_group_settings BEFORE UPDATE ON settings BEGIN SELECT RAISE(FAIL, 'fixture failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	settings.Public.ModelChannel.UserGroups = settings.Public.ModelChannel.UserGroups[:1]
	if _, err = repository.SaveSettings(settings, "now"); err == nil {
		t.Fatal("fixture should reject settings write")
	}
	updated, _, err = repository.GetUserByID("u")
	if err != nil || updated.GroupID != "vip" {
		t.Fatal("group removal was not atomic")
	}
}

func TestUserGroupChannelScopesSelectionAndHTTP(t *testing.T) {
	if os.Getenv("IC_GROUP_SCOPE_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestUserGroupChannelScopesSelectionAndHTTP$", "-test.v")
		command.Env = append(os.Environ(), "IC_GROUP_SCOPE_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("channel scope fixture: %v\n%s", err, output)
		}
		return
	}
	root := t.TempDir()
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(root, "scopes.db")
	config.Cfg.AILogDir = filepath.Join(root, "logs")
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	allow := true
	var settings model.Settings
	if err := json.Unmarshal([]byte("{\"public\":{\"modelChannel\":{\"availableModels\":[\"gpt-image-2\",\"text\"],\"userGroups\":[{\"id\":\"default\",\"isDefault\":true,\"unrestricted\":true},{\"id\":\"vip\",\"models\":[],\"scopes\":[{\"channelId\":\"Mark\",\"model\":\"gpt-image-2\"}]}]}}}"), &settings); err != nil {
		t.Fatal(err)
	}
	settings.Public.ModelChannel.AllowUserRemoteChannel = &allow
	var upstreamChannels []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamChannels = append(upstreamChannels, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("{\"error\":\"local fixture only\"}"))
	}))
	defer upstream.Close()
	for _, id := range []string{"Mark", "4K"} {
		settings.Private.Channels = append(settings.Private.Channels, model.ModelChannel{ID: id, Name: id, Enabled: true, BaseURL: upstream.URL, APIKey: id, Models: []string{"gpt-image-2", "text"}, Weight: 1})
		settings.Public.ModelChannel.ModelCosts = append(settings.Public.ModelChannel.ModelCosts, model.ModelCost{ChannelID: id, Model: "gpt-image-2", Credits: 0})
	}
	if _, err := service.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	user := model.AuthUser{ID: "u", Role: model.UserRoleUser, GroupID: "vip"}
	ctx := service.WithUser(context.Background(), user)
	if err := db.Create(&model.User{ID: "u", Username: "u", AffCode: "u", Role: model.UserRoleUser, Status: model.UserStatusActive, GroupID: "vip"}).Error; err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"Mark", ""} {
		for attempt := 0; attempt < 10; attempt++ {
			channel, err := service.SelectModelChannelForUser(ctx, "gpt-image-2", id, true)
			if err != nil || channel.ID != "Mark" {
				t.Fatalf("scoped selection id=%q: %s %v", id, channel.ID, err)
			}
		}
	}
	if _, err := service.SelectModelChannelForUser(ctx, "gpt-image-2", "4K", true); err == nil || err.Error() != "模型未开放" {
		t.Fatalf("disallowed duplicate: %v", err)
	}
	if _, err := service.SelectModelChannelForUser(ctx, "gpt-image-2", "missing", true); err == nil || err.Error() != "指定模型渠道不可用" {
		t.Fatalf("unknown channel: %v", err)
	}
	for _, id := range []string{"Mark", "4K"} {
		if _, err := service.SelectModelChannelForUser(ctx, "gpt-image-2", id, false); err != nil {
			t.Fatal("task continuation changed", err)
		}
		if _, err := service.SelectModelChannelForModel("gpt-image-2", id, true); err != nil {
			t.Fatal("background call changed", err)
		}
	}
	response := httptest.NewRecorder()
	handler.Settings(response, httptest.NewRequest(http.MethodGet, "/settings", nil).WithContext(ctx))
	var result struct {
		Code int
		Data model.PublicSetting
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Code != 0 || len(result.Data.ModelChannel.Channels) != 1 || result.Data.ModelChannel.Channels[0].ID != "Mark" || len(result.Data.ModelChannel.ModelCosts) != 1 {
		t.Fatalf("HTTP projection: %s", response.Body.String())
	}
	config.Cfg.JWTSecret = "test-only-channel-scope-secret"
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{UserID: user.ID, Role: user.Role}).SignedString([]byte(config.Cfg.JWTSecret))
	if err != nil {
		t.Fatal(err)
	}
	engine := gin.New()
	engine.POST("/api/v1/images/generations", middleware.UserAuth, gin.WrapF(handler.AIImagesGenerations))
	engine.GET("/api/settings", middleware.OptionalAuth, gin.WrapF(handler.Settings))
	for _, id := range []string{"Mark", "4K", ""} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/images/generations", strings.NewReader("{\"model\":\"gpt-image-2\",\"prompt\":\"fixture\"}"))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		if id != "" {
			request.Header.Set("X-Model-Channel-ID", id)
		}
		before := len(upstreamChannels)
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, request)
		if id == "4K" {
			if len(upstreamChannels) != before || !strings.Contains(response.Body.String(), "模型未开放") {
				t.Fatalf("4K reached upstream: %s", response.Body)
			}
		} else if len(upstreamChannels) != before+1 || upstreamChannels[len(upstreamChannels)-1] != "Mark" {
			t.Fatalf("request id=%q chose wrong upstream: %v %s", id, upstreamChannels, response.Body)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response = httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Code != 0 || len(result.Data.ModelChannel.Channels) != 1 || result.Data.ModelChannel.Channels[0].ID != "Mark" || len(result.Data.ModelChannel.ModelCosts) != 1 || result.Data.ModelChannel.ModelCosts[0].ChannelID != "Mark" {
		t.Fatalf("authenticated projection: %s", response.Body)
	}
	settings.Private.Channels[0].Enabled = false
	if _, err := repository.SaveSettings(settings, "now"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SelectModelChannelForUser(ctx, "gpt-image-2", "", true); err == nil || err.Error() != "模型未开放" {
		t.Fatalf("disabled allowed channel: %v", err)
	}
	settings.Private.Channels[0].Enabled = true
	settings.Public.ModelChannel.UserGroups[1].Models = []string{"gpt-image-2"}
	if _, err := service.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"Mark", "4K"} {
		if _, err := service.SelectModelChannelForUser(ctx, "gpt-image-2", id, true); err != nil {
			t.Fatal("legacy whitelist changed", err)
		}
	}
	settings.Public.ModelChannel.UserGroups[1].Models = []string{"text"}
	if _, err := service.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"Mark", "4K"} {
		if _, err := service.SelectModelChannelForUser(ctx, "text", id, true); err != nil {
			t.Fatal("mixed legacy permission lost", err)
		}
	}
	if _, err := service.SelectModelChannelForUser(ctx, "gpt-image-2", "4K", true); err == nil {
		t.Fatal("mixed scoped permission widened")
	}
	for _, scopeJSON := range []string{"[{\"channelId\":\"missing\",\"model\":\"gpt-image-2\"}]", "[{\"channelId\":\"Mark\",\"model\":\"hidden\"}]"} {
		var invalid model.UserGroupSetting
		if err := json.Unmarshal([]byte("{\"id\":\"vip\",\"models\":[],\"scopes\":"+scopeJSON+"}"), &invalid); err != nil {
			t.Fatal(err)
		}
		settings.Public.ModelChannel.UserGroups[1] = invalid
		if _, err := service.SaveSettings(settings); err == nil {
			t.Fatal("invalid scope saved")
		}
	}
}
