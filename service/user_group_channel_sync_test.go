package service

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestUserGroupScopeNormalizationChecksChannelMembership(t *testing.T) {
	channels := []model.ModelChannel{
		{ID: "a", Models: []string{"local"}},
		{ID: "b", Models: []string{"other"}},
	}
	groups := []model.UserGroupSetting{{ID: "default", IsDefault: true, Scopes: []model.UserGroupModelScope{
		{ChannelID: "a", Model: "other"}, {ChannelID: "a", Model: "local"},
	}}}
	normalized := normalizeUserGroups(groups, []string{"local", "other"}, channels)
	expected := []model.UserGroupModelScope{{ChannelID: "a", Model: "local"}}
	if !reflect.DeepEqual(normalized[0].Scopes, expected) {
		t.Fatalf("channel-external same-name binding survived: %+v", normalized[0].Scopes)
	}
}

func TestUserGroupScopeRenameInferenceIsUnambiguousAndDoesNotMutateInput(t *testing.T) {
	old := []model.ModelChannel{{ID: "a", Models: []string{"old"}, ModelMap: map[string]string{"old": "upstream"}}}
	next := []model.ModelChannel{{ID: "a", Models: []string{"one", "two"}, ModelMap: map[string]string{"one": "upstream", "two": "upstream"}}}
	groups := []model.UserGroupSetting{
		{ID: "default", IsDefault: true, Scopes: []model.UserGroupModelScope{{ChannelID: "a", Model: "old"}}},
		{ID: "all", Unrestricted: true},
	}
	before, _ := json.Marshal(groups)
	result, cleaned, err := reconcileUserGroupScopes(groups, groups, old, next, []string{"one", "two"}, nil)
	if err != nil || len(result[0].Scopes) != 0 || len(cleaned) != 1 || cleaned[0].Reason != "model_removed" {
		t.Fatalf("ambiguous rename granted a model: %+v %+v %v", result, cleaned, err)
	}
	result, cleaned, err = reconcileUserGroupScopes(groups, groups, old, next, []string{"one", "two"}, []ModelRename{{ChannelID: "a", From: "old", To: "two"}})
	if err != nil || len(result[0].Scopes) != 1 || result[0].Scopes[0].Model != "two" || len(cleaned) != 1 || cleaned[0].Reason != "model_renamed" {
		t.Fatalf("explicit rename not applied: %+v %+v %v", result, cleaned, err)
	}
	after, _ := json.Marshal(groups)
	if string(after) != string(before) || old[0].ModelMap["old"] != "upstream" || next[0].Models[0] != "one" {
		t.Fatal("scope reconciliation changed caller input or channel data")
	}
	// A freshly added invalid reference must not inherit another group's rename permission.
	groups[1].Unrestricted = false
	groups[1].Scopes = []model.UserGroupModelScope{{ChannelID: "a", Model: "old"}}
	saved := []model.UserGroupSetting{groups[0], {ID: "all"}}
	if _, _, err := reconcileUserGroupScopes(groups, saved, old, next, []string{"one", "two"}, []ModelRename{{ChannelID: "a", From: "old", To: "two"}}); err == nil {
		t.Fatal("new invalid binding was silently treated as an inherited rename")
	}
}
