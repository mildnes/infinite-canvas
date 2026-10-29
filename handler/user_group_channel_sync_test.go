package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestUserGroupChannelAuthoritySave(t *testing.T) {
	if os.Getenv("IC_GROUP_CHANNEL_SYNC_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestUserGroupChannelAuthoritySave$", "-test.v")
		command.Env = append(os.Environ(), "IC_GROUP_CHANNEL_SYNC_FIXTURE=1")
		output, err := command.CombinedOutput()
		t.Log(string(output))
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "groups.db")
	config.Cfg.AILogDir = t.TempDir()
	type change struct {
		GroupID   string `json:"groupId"`
		ChannelID string `json:"channelId"`
		Model     string `json:"model"`
		Reason    string `json:"reason"`
	}
	type response struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			model.Settings
			Cleaned []change `json:"cleaned"`
		} `json:"data"`
	}
	fixture := func() model.Settings {
		return model.Settings{
			Private: model.PrivateSetting{Channels: []model.ModelChannel{
				{ID: "GPT2", Name: "GPT2渠道", Enabled: true, Protocol: "openai", Models: []string{"old", "keep"}, ModelMap: map[string]string{"old": "upstream-old"}, Weight: 3},
				{ID: "other", Name: "其他渠道", Enabled: true, Protocol: "openai", Models: []string{"old", "text"}, Weight: 7},
			}},
			Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{
				AvailableModels: []string{"old", "keep", "text"},
				ModelCosts:      []model.ModelCost{{ChannelID: "GPT2", Model: "keep", Credits: 3}, {ChannelID: "other", Model: "old", Credits: 5}},
				UserGroups: []model.UserGroupSetting{
					{ID: "default", Name: "默认用户", IsDefault: true, Models: []string{}, Scopes: []model.UserGroupModelScope{{ChannelID: "GPT2", Model: "old"}, {ChannelID: "GPT2", Model: "keep"}, {ChannelID: "other", Model: "old"}}},
					{ID: "vip", Name: "VIP", Models: []string{}, Scopes: []model.UserGroupModelScope{{ChannelID: "GPT2", Model: "old"}}},
					{ID: "all", Name: "不限", Unrestricted: true, Models: []string{}},
				},
			}},
		}
	}
	seed := func(settings model.Settings) {
		t.Helper()
		if _, err := repository.SaveSettings(settings, "fixture"); err != nil {
			t.Fatal(err)
		}
	}
	post := func(settings model.Settings, renames ...map[string]string) response {
		t.Helper()
		payload := struct {
			model.Settings
			ModelRenames []map[string]string `json:"modelRenames,omitempty"`
		}{settings, renames}
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		handler.AdminSaveSettings(w, httptest.NewRequest(http.MethodPost, "/api/admin/settings", bytes.NewReader(body)))
		var result response
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	checkSuccess := func(t *testing.T, result response) {
		t.Helper()
		if result.Code != 0 {
			t.Fatalf("save rejected: %s", result.Msg)
		}
		saved, err := repository.GetSettings()
		if err != nil || !reflect.DeepEqual(saved.Public.ModelChannel.UserGroups, result.Data.Public.ModelChannel.UserGroups) {
			t.Fatalf("response and database differ: %+v err=%v", result, err)
		}
		all := result.Data.Public.ModelChannel.UserGroups[2]
		if !all.Unrestricted || len(all.Scopes) != 0 || len(all.Models) != 0 {
			t.Fatal("unrestricted group changed")
		}
	}
	checkIdempotent := func(t *testing.T, settings model.Settings, renames ...map[string]string) {
		t.Helper()
		repeated := post(settings, renames...)
		checkSuccess(t, repeated)
		if len(repeated.Data.Cleaned) != 0 {
			t.Fatalf("repeated request cleaned again: %+v", repeated.Data.Cleaned)
		}
	}
	for _, scenario := range []string{"channel_removed", "model_removed", "explicit_rename", "unknown_rename", "inferred_rename", "passthrough_not_inferred"} {
		t.Run(scenario, func(t *testing.T) {
			input := fixture()
			if scenario == "passthrough_not_inferred" {
				input.Private.Channels[0].ModelMap = nil
			}
			seed(input)
			var renames []map[string]string
			reason := "model_removed"
			switch scenario {
			case "channel_removed":
				input.Private.Channels = input.Private.Channels[1:]
				reason = "channel_removed"
			case "model_removed":
				input.Private.Channels[0].Models = []string{"keep"}
				input.Private.Channels[0].ModelMap = nil
			default:
				input.Private.Channels[0].Models = []string{"new", "keep"}
				input.Private.Channels[0].ModelMap = map[string]string{"new": "upstream-new"}
				input.Public.ModelChannel.AvailableModels = append(input.Public.ModelChannel.AvailableModels, "new")
				if scenario == "explicit_rename" {
					renames = []map[string]string{{"channelId": "GPT2", "from": "old", "to": "new"}}
					reason = "model_renamed"
				}
				if scenario == "inferred_rename" {
					input.Private.Channels[0].ModelMap["new"] = "upstream-old"
					reason = "model_renamed"
				}
				if scenario == "passthrough_not_inferred" {
					input.Private.Channels[0].ModelMap = nil
				}
			}
			result := post(input, renames...)
			checkSuccess(t, result)
			expected := []model.UserGroupModelScope{{ChannelID: "GPT2", Model: "keep"}, {ChannelID: "other", Model: "old"}}
			expectedChanges := 2
			if scenario == "channel_removed" {
				expected = expected[1:]
				expectedChanges = 3
			}
			if reason == "model_renamed" {
				expected = append([]model.UserGroupModelScope{{ChannelID: "GPT2", Model: "new"}}, expected...)
			}
			if !reflect.DeepEqual(result.Data.Public.ModelChannel.UserGroups[0].Scopes, expected) {
				t.Fatalf("scopes actual=%+v expected=%+v", result.Data.Public.ModelChannel.UserGroups[0].Scopes, expected)
			}
			if len(result.Data.Cleaned) != expectedChanges {
				t.Fatalf("cleaned actual=%+v expected count=%d", result.Data.Cleaned, expectedChanges)
			}
			for _, item := range result.Data.Cleaned {
				if item.Reason != reason || item.ChannelID != "GPT2" || item.GroupID == "" || item.Model == "" {
					t.Fatalf("incomplete cleanup receipt: %+v", item)
				}
			}
			if reason != "model_renamed" {
				ctx := service.WithUser(context.Background(), model.AuthUser{ID: "u", GroupID: "vip"})
				if _, err := service.SelectModelChannelForUser(ctx, "old", "", true); err == nil {
					t.Fatal("empty restricted group widened to another same-name channel")
				}
			}
			if len(result.Data.Private.Channels) != len(input.Private.Channels) || result.Data.Private.Channels[len(input.Private.Channels)-1].ID != "other" || result.Data.Private.Channels[len(input.Private.Channels)-1].Weight != 7 {
				t.Fatal("channel order or weight changed")
			}
			if !reflect.DeepEqual(result.Data.Public.ModelChannel.ModelCosts, input.Public.ModelChannel.ModelCosts) {
				t.Fatal("unrelated model billing changed")
			}
			checkIdempotent(t, input, renames...)
		})
	}
	for _, scenario := range []string{"new_unknown_channel", "new_unknown_model", "channel_deleted_and_new_scope"} {
		t.Run(scenario, func(t *testing.T) {
			input := fixture()
			seed(input)
			scope := model.UserGroupModelScope{ChannelID: "GPT2", Model: "text"}
			if scenario == "new_unknown_channel" {
				scope.ChannelID = "missing-channel"
			}
			if scenario == "channel_deleted_and_new_scope" {
				input.Private.Channels = input.Private.Channels[1:]
			}
			input.Public.ModelChannel.UserGroups[0].Scopes = append(input.Public.ModelChannel.UserGroups[0].Scopes, scope)
			result := post(input)
			if result.Code == 0 || !strings.Contains(result.Msg, "默认用户") || !strings.Contains(result.Msg, scope.ChannelID) || !strings.Contains(result.Msg, scope.Model) {
				t.Fatalf("expected actionable rejection with group/channel/model; code=%d msg=%q", result.Code, result.Msg)
			}
			saved, err := repository.GetSettings()
			if err != nil || !reflect.DeepEqual(saved.Public.ModelChannel.UserGroups, fixture().Public.ModelChannel.UserGroups) || len(saved.Private.Channels) != 2 {
				t.Fatalf("rejected save changed persisted groups or channels: %+v err=%v", saved, err)
			}
		})
	}
	t.Run("stored_invalid_scope_is_cleaned_on_first_save", func(t *testing.T) {
		input := fixture()
		input.Private.Channels[0].Models = []string{"高质量gpt-image-2", "keep"}
		input.Private.Channels[0].ModelMap = map[string]string{"高质量gpt-image-2": "gpt-image-2-high"}
		input.Public.ModelChannel.UserGroups[0].Scopes[0].Model = "gpt-image-2"
		input.Public.ModelChannel.UserGroups[1].Scopes = nil
		seed(input)
		result := post(input)
		checkSuccess(t, result)
		if len(result.Data.Cleaned) != 1 || result.Data.Cleaned[0].Reason != "model_removed" {
			t.Fatalf("legacy cleanup missing: %+v", result.Data.Cleaned)
		}
		checkIdempotent(t, input)
		// A different request adding a new bad binding must still be rejected.
		input = result.Data.Settings
		input.Public.ModelChannel.UserGroups[0].Scopes = append(input.Public.ModelChannel.UserGroups[0].Scopes, model.UserGroupModelScope{ChannelID: "missing", Model: "brand-new-invalid"})
		if post(input).Code == 0 {
			t.Fatal("cleanup replay exemption accepted a new invalid scope")
		}
	})
	t.Run("new_model_is_not_authorized_and_unrestricted_stays_empty", func(t *testing.T) {
		input := fixture()
		seed(input)
		input.Private.Channels[0].Models = append(input.Private.Channels[0].Models, "new")
		input.Public.ModelChannel.AvailableModels = append(input.Public.ModelChannel.AvailableModels, "new")
		result := post(input)
		checkSuccess(t, result)
		if !reflect.DeepEqual(result.Data.Public.ModelChannel.UserGroups, fixture().Public.ModelChannel.UserGroups) || len(result.Data.Cleaned) != 0 {
			t.Fatalf("new model implicitly authorized: %+v", result.Data.Public.ModelChannel.UserGroups)
		}
		checkIdempotent(t, input)
	})
	t.Run("normalized_admin_read_does_not_hide_cleanup_of_persisted_stale_scopes", func(t *testing.T) {
		input := fixture()
		input.Private.Channels[0].Models = []string{"keep"}
		input.Private.Channels[0].ModelMap = nil
		seed(input)
		w := httptest.NewRecorder()
		handler.AdminSettings(w, httptest.NewRequest(http.MethodGet, "/api/admin/settings", nil))
		var read response
		if err := json.Unmarshal(w.Body.Bytes(), &read); err != nil || read.Code != 0 {
			t.Fatalf("admin GET failed: %s", w.Body)
		}
		result := post(read.Data.Settings)
		checkSuccess(t, result)
		if len(result.Data.Cleaned) != 2 {
			t.Fatalf("persisted stale scopes were hidden by GET normalization: %+v", result.Data.Cleaned)
		}
		checkIdempotent(t, read.Data.Settings)
	})
	t.Run("unrestricted_skips_invalid_scopes_and_raw_default_structure_remains_strict", func(t *testing.T) {
		input := fixture()
		seed(input)
		input.Public.ModelChannel.UserGroups[2].Scopes = []model.UserGroupModelScope{{ChannelID: "missing", Model: "missing"}}
		result := post(input)
		checkSuccess(t, result)
		if len(result.Data.Cleaned) != 0 {
			t.Fatal("unrestricted group participated in scope cleanup")
		}
		for _, scenario := range []string{"duplicate_id", "missing_default", "wrong_default_id"} {
			t.Run(scenario, func(t *testing.T) {
				input := fixture()
				switch scenario {
				case "duplicate_id":
					input.Public.ModelChannel.UserGroups[1].ID = "default"
				case "missing_default":
					input.Public.ModelChannel.UserGroups[0].IsDefault = false
				case "wrong_default_id":
					input.Public.ModelChannel.UserGroups[0].ID = "renamed-default"
				}
				if post(input).Code == 0 {
					t.Fatal("invalid default structure accepted")
				}
			})
		}
	})
}
