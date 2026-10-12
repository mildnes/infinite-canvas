package service

import (
	"context"
	"reflect"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestHidePrivateAPIKeysDoesNotMutateChannelInput(t *testing.T) {
	channels := []model.ModelChannel{
		{ID: "first", APIKey: "fixture-api-key", UploadAPIKey: "fixture-upload-key", Models: []string{"text"}},
		{ID: "second", APIKey: "second-api-key", UploadAPIKey: "second-upload-key"},
	}
	original := append([]model.ModelChannel{}, channels...)
	settings := model.Settings{Private: model.PrivateSetting{Channels: channels}}
	redacted := hidePrivateAPIKeys(settings)
	if !reflect.DeepEqual(settings.Private.Channels, original) {
		t.Fatal("redaction mutated the caller's channels")
	}
	for i, channel := range redacted.Private.Channels {
		if channel.APIKey != "" || channel.UploadAPIKey != "" {
			t.Fatal("redacted channel exposed credentials")
		}
		if channel.ID != original[i].ID || !reflect.DeepEqual(channel.Models, original[i].Models) {
			t.Fatal("redaction changed non-secret fields")
		}
	}
	redacted.Private.Channels[0].APIKey = "changed-return-copy"
	if !reflect.DeepEqual(settings.Private.Channels, original) {
		t.Fatal("returned channels still share the input backing array")
	}
}

func TestUserGroupPermissionsFailClosedAndGlobalGate(t *testing.T) {
	settings := model.Settings{Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{
		AvailableModels: []string{"gpt-image-visible", "text"},
		UserGroups: []model.UserGroupSetting{
			{ID: "default", IsDefault: true, Unrestricted: true},
			{ID: "vip", Models: []string{"text"}},
			{ID: "empty", Models: []string{}},
		},
	}}}
	for _, tc := range []struct {
		group, model string
		allowed      bool
	}{
		{"vip", "text", true}, {"vip", "gpt-image-visible", false},
		{"empty", "text", false}, {"default", "hidden", false},
		{"", "text", true}, {"missing", "text", true},
	} {
		ctx := WithUser(context.Background(), model.AuthUser{ID: "user", GroupID: tc.group})
		err := checkUserGroupModelAccess(ctx, settings, tc.model)
		if (err == nil) != tc.allowed {
			t.Fatalf("group=%s model=%s err=%v", tc.group, tc.model, err)
		}
	}
	settings.Public.ModelChannel.AvailableModels = nil
	if err := checkUserGroupModelAccess(context.Background(), settings, "hidden"); err != nil {
		t.Fatal(err)
	}
	if err := checkUserGroupModelAccess(WithUser(context.Background(), model.AuthUser{ID: "u", GroupID: "empty"}), settings, "text"); err == nil {
		t.Fatal("empty restricted group allowed a model")
	}
}

func TestUserGroupSettingsEmptyAndStrictDefaults(t *testing.T) {
	channel := model.PublicModelChannelInfo{Models: []string{"gpt-image-visible", "text"}, ModelMap: map[string]string{"gpt-image-visible": "upstream", "text": "text"}}
	setting := model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{
		AvailableModels: channel.Models, Channels: []model.PublicModelChannelInfo{channel}, DefaultImageModel: "gpt-image-visible",
		UserGroups: []model.UserGroupSetting{{ID: "default", IsDefault: true, Models: []string{"text"}}, {ID: "empty"}},
	}}
	for _, group := range []string{"", "unknown", "default"} {
		result := filterPublicSettingsForUser(setting, model.AuthUser{ID: "u", GroupID: group})
		if !reflect.DeepEqual(result.ModelChannel.AvailableModels, []string{"text"}) || result.ModelChannel.DefaultImageModel != "" {
			t.Fatalf("default fallback: %+v", result.ModelChannel)
		}
		if len(result.ModelChannel.Channels[0].ModelMap) != 1 {
			t.Fatal("group-external mapping leaked")
		}
	}
	empty := filterPublicSettingsForUser(setting, model.AuthUser{ID: "u", GroupID: "empty"})
	if len(empty.ModelChannel.AvailableModels) != 0 || len(empty.ModelChannel.Channels) != 0 {
		t.Fatal("empty restriction returned models")
	}
	guest := filterPublicSettingsForUser(setting, model.AuthUser{})
	if !reflect.DeepEqual(guest, setting) {
		t.Fatal("guest settings changed")
	}
}

func TestUserGroupSaveValidationAndLegacyDefault(t *testing.T) {
	legacy := normalizeUserGroups(nil, []string{"text"})
	if len(legacy) != 1 || legacy[0].ID != "default" || !legacy[0].Unrestricted || len(legacy[0].Models) != 0 {
		t.Fatalf("legacy groups: %+v", legacy)
	}
	saved := []model.UserGroupSetting{{ID: "default", IsDefault: true, Unrestricted: true}}
	for _, groups := range [][]model.UserGroupSetting{
		nil,
		{{ID: "vip", IsDefault: true}},
		{{ID: "default", IsDefault: true}, {ID: "default"}},
		{{ID: "default", IsDefault: true}, {ID: "vip", Models: []string{"hidden"}}},
	} {
		if err := validateUserGroups(groups, saved, []string{"text"}); err == nil {
			t.Fatalf("invalid groups accepted: %+v", groups)
		}
	}
	if err := validateUserGroups(saved, saved, []string{"text"}); err != nil {
		t.Fatal(err)
	}
	if err := validateUserGroupID("", saved); err != nil {
		t.Fatal("empty group must be accepted")
	}
	if err := validateUserGroupID("missing", saved); err == nil {
		t.Fatal("unknown group accepted")
	}
	if model.PublicUser(model.User{GroupID: "vip"}).GroupID != "vip" {
		t.Fatal("auth context lost group")
	}
}

func TestUserGroupNormalizationKeepsWhitelistWhenGlobalListIsLegacyEmpty(t *testing.T) {
	setting := model.Settings{
		Private: model.PrivateSetting{Channels: []model.ModelChannel{{ID: "system", Enabled: true, Models: []string{"text"}}}},
		Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{
			UserGroups: []model.UserGroupSetting{{ID: "default", IsDefault: true, Unrestricted: true}, {ID: "vip", Models: []string{"text"}}},
		}},
	}
	result := normalizeSettings(setting)
	if !reflect.DeepEqual(result.Public.ModelChannel.UserGroups[1].Models, []string{"text"}) {
		t.Fatal("legacy global list erased group whitelist")
	}
	ctx := WithUser(context.Background(), model.AuthUser{ID: "u", GroupID: "vip"})
	if err := checkUserGroupModelAccess(ctx, result, "text"); err != nil {
		t.Fatal(err)
	}
	if err := checkUserGroupModelAccess(ctx, result, "hidden"); err == nil {
		t.Fatal("restricted group bypassed legacy global list")
	}
}

func TestUserGroupProjectionFiltersAllDeclarationsAndSelectsImageDefault(t *testing.T) {
	channel := model.PublicModelChannelInfo{
		Models:                   []string{"outside", "我的高质图", "text"},
		ModelMap:                 map[string]string{"outside": "gpt-image-hidden", "我的高质图": "gpt-image-2.5-sunburst"},
		ModelCapabilities:        map[string][]model.ModelCapability{"outside": {model.ModelCapabilityImage}, "我的高质图": {model.ModelCapabilityImage}, "text": {model.ModelCapabilityText}},
		ImageQualityCapabilities: map[string]model.ImageQualityCapability{"outside": {Values: []string{"high"}}, "我的高质图": {Values: []string{"high"}}},
		ImageOutputCapabilities:  map[string]model.ImageOutputCapability{"outside": {Formats: []model.ImageOutputFormat{"png"}}, "我的高质图": {Formats: []model.ImageOutputFormat{"png"}}},
	}
	setting := model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{
		AvailableModels: channel.Models, Channels: []model.PublicModelChannelInfo{channel}, DefaultImageModel: "outside",
		UserGroups: []model.UserGroupSetting{{ID: "default", IsDefault: true, Unrestricted: true}, {ID: "vip", Models: []string{"我的高质图", "text"}}},
	}}
	result := filterPublicSettingsForUser(setting, model.AuthUser{ID: "u", GroupID: "vip"})
	if result.ModelChannel.DefaultImageModel != "我的高质图" {
		t.Fatalf("image default: %s", result.ModelChannel.DefaultImageModel)
	}
	projected := result.ModelChannel.Channels[0]
	if !reflect.DeepEqual(projected.Models, []string{"我的高质图", "text"}) {
		t.Fatalf("models: %v", projected.Models)
	}
	if len(projected.ModelMap) != 1 || len(projected.ModelCapabilities) != 2 || len(projected.ImageQualityCapabilities) != 1 || len(projected.ImageOutputCapabilities) != 1 {
		t.Fatalf("declarations leaked: %+v", projected)
	}
	// Projection must not mutate the source settings used for another user.
	if len(setting.ModelChannel.Channels[0].ModelMap) != 2 {
		t.Fatal("source settings mutated")
	}
}

func TestUserGroupProjectionFiltersModelCosts(t *testing.T) {
	setting := model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{
		AvailableModels: []string{"outside", "我的高质图", "text"},
		ModelCosts: []model.ModelCost{
			{ChannelID: "system", Model: "outside", Credits: 97},
			{ChannelID: "system", Model: "我的高质图", Credits: 3},
			{ChannelID: "system", Model: "text", Credits: 1},
		},
		Channels: []model.PublicModelChannelInfo{{
			Models: []string{"outside", "我的高质图", "text"},
		}},
		UserGroups: []model.UserGroupSetting{
			{ID: "default", IsDefault: true, Unrestricted: true},
			{ID: "vip", Models: []string{"我的高质图", "text"}},
		},
	}}
	restricted := filterPublicSettingsForUser(setting, model.AuthUser{ID: "u", GroupID: "vip"})
	if !reflect.DeepEqual(restricted.ModelChannel.ModelCosts, []model.ModelCost{
		{ChannelID: "system", Model: "我的高质图", Credits: 3},
		{ChannelID: "system", Model: "text", Credits: 1},
	}) {
		t.Fatalf("restricted group leaked costs: %+v", restricted.ModelChannel.ModelCosts)
	}
	unrestricted := filterPublicSettingsForUser(setting, model.AuthUser{ID: "a"})
	if len(unrestricted.ModelChannel.ModelCosts) != 3 {
		t.Fatalf("unrestricted group lost costs: %+v", unrestricted.ModelChannel.ModelCosts)
	}
	// Source settings must stay intact for other users.
	if len(setting.ModelChannel.ModelCosts) != 3 {
		t.Fatal("source settings mutated")
	}
}
