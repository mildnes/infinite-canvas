package service

import (
	"reflect"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestResolveImageQualityCapabilityUsesChannelDeclaration(t *testing.T) {
	channel := model.ModelChannel{
		Protocol: "openai",
		BaseURL:  "https://custom.example/v1",
		ImageQualityCapabilities: map[string]model.ImageQualityCapability{
			"image-model": {
				Values: []string{"low", "medium", "high", "auto"},
				Map: map[string]string{
					"xhigh": "high",
					"max":   "high",
					"bad":   "unknown",
				},
				DefaultValue: "high",
			},
			"unsupported-model": {},
		},
	}

	got, ok := ResolveImageQualityCapability(channel, " image-model ")
	want := model.ImageQualityCapability{
		Values: []string{"low", "medium", "high", "auto"},
		Map: map[string]string{
			"xhigh": "high",
			"max":   "high",
		},
		DefaultValue: "high",
	}
	if !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("capability = %#v, %v; want %#v, true", got, ok, want)
	}

	got, ok = ResolveImageQualityCapability(channel, "unsupported-model")
	if !ok || len(got.Values) != 0 || got.DefaultValue != "" {
		t.Fatalf("explicit unsupported capability = %#v, %v; want declared empty capability", got, ok)
	}

	if _, ok := ResolveImageQualityCapability(channel, "unlisted-model"); ok {
		t.Fatal("undeclared model must retain passthrough behavior")
	}
}

func TestNormalizeImageQualityCapabilitiesKeepsOnlyValidMappings(t *testing.T) {
	got := normalizeImageQualityCapabilities(map[string]model.ImageQualityCapability{
		" image-model ": {
			Values:       []string{" low ", "low", "high", ""},
			Map:          map[string]string{" MAX ": " high ", "bad": "unknown", " ": "low"},
			DefaultValue: " unknown ",
		},
		" ": {Values: []string{"high"}},
	})
	want := map[string]model.ImageQualityCapability{
		"image-model": {
			Values: []string{"low", "high"},
			Map:    map[string]string{"max": "high"},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalized capabilities = %#v, want %#v", got, want)
	}
}

func TestPublicChannelInfosPublishesOnlyDeclaredQualityCapabilities(t *testing.T) {
	settings := normalizeSettings(model.Settings{
		Private: model.PrivateSetting{Channels: []model.ModelChannel{{
			ID:       "quality-channel",
			Protocol: ModelChannelProtocolOpenAI,
			BaseURL:  "https://custom.example/v1",
			APIKey:   "secret",
			Models:   []string{"image-model", "other-image-model"},
			Enabled:  true,
			ImageQualityCapabilities: map[string]model.ImageQualityCapability{
				"image-model": {
					Values:       []string{"low", "medium", "high", "auto"},
					Map:          map[string]string{"xhigh": "high", "max": "high"},
					DefaultValue: "high",
				},
			},
		}}},
		Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{
			AvailableModels: []string{"image-model"},
		}},
	})

	infos := publicChannelInfos(settings.Private.Channels, settings.Public.ModelChannel.AvailableModels)
	if len(infos) != 1 {
		t.Fatalf("public channels = %#v, want one", infos)
	}
	want := map[string]model.ImageQualityCapability{
		"image-model": {
			Values:       []string{"low", "medium", "high", "auto"},
			Map:          map[string]string{"xhigh": "high", "max": "high"},
			DefaultValue: "high",
		},
	}
	if !reflect.DeepEqual(infos[0].ImageQualityCapabilities, want) {
		t.Fatalf("published image quality capabilities = %#v, want %#v", infos[0].ImageQualityCapabilities, want)
	}
}

func TestLegacyChannelsHaveNoInferredImageQualityCapability(t *testing.T) {
	channel := model.ModelChannel{Protocol: ModelChannelProtocolOpenAI, BaseURL: "https://api.openai.com/v1"}
	if _, ok := ResolveImageQualityCapability(channel, "gpt-image-2"); ok {
		t.Fatal("legacy channel must not gain an inferred quality capability")
	}
}
