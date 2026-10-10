package service

import (
	"reflect"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestResolveUpstreamModelName(t *testing.T) {
	channel := model.ModelChannel{ModelMap: map[string]string{"local": " upstream ", "other": "upstream", "empty": " 	 "}}
	for _, test := range []struct{ local, want string }{
		{"local", "upstream"}, {" local ", "upstream"}, {"other", "upstream"},
		{"missing", "missing"}, {" missing ", " missing "}, {"empty", "empty"}, {"LOCAL", "LOCAL"},
	} {
		if got := ResolveUpstreamModelName(channel, test.local); got != test.want {
			t.Errorf("ResolveUpstreamModelName(%q) = %q, want %q", test.local, got, test.want)
		}
	}
	for _, mapping := range []map[string]string{nil, {}} {
		if got := ResolveUpstreamModelName(model.ModelChannel{ModelMap: mapping}, " local "); got != " local " {
			t.Fatalf("unconfigured channel changed model: %q", got)
		}
	}
}

func TestModelCapabilityFallbackUsesMappedUpstreamName(t *testing.T) {
	channels := []model.ModelChannel{{Models: []string{"我的高质图"}, ModelMap: map[string]string{"我的高质图": "gpt-image-2.5-sunburst"}}}
	if !modelMatchesCapability(channels, "我的高质图", model.ModelCapabilityImage, isImageModelName) {
		t.Fatal("mapped upstream image model should satisfy image capability fallback")
	}
	if got := repairDefaultModelForCapability("", []string{"我的高质图"}, channels, model.ModelCapabilityImage, isImageModelName); got != "我的高质图" {
		t.Fatalf("repairDefaultModelForCapability() = %q, want local alias", got)
	}
	if modelMatchesCapability(channels, "我的高质图", model.ModelCapabilityText, isTextModelName) {
		t.Fatal("custom image alias must not fall back to text capability")
	}
}

func TestPublicChannelMappingPreservesLocalModelsAndDeclarations(t *testing.T) {
	channel := model.ModelChannel{ID: "channel", Enabled: true, APIKey: "key", BaseURL: "https://example.invalid", Models: []string{"local"},
		ModelMap:                 map[string]string{"local": "upstream"},
		ModelCapabilities:        map[string][]model.ModelCapability{"local": {model.ModelCapabilityImage}},
		ImageOutputCapabilities:  map[string]model.ImageOutputCapability{"local": {Formats: []model.ImageOutputFormat{model.ImageOutputFormatPNG}}},
		ImageQualityCapabilities: map[string]model.ImageQualityCapability{"local": {Values: []string{"high"}}},
	}
	infos := publicChannelInfos([]model.ModelChannel{channel}, []string{"local"})
	if len(infos) != 1 || !reflect.DeepEqual(infos[0].Models, []string{"local"}) || infos[0].ModelMap["local"] != "upstream" {
		t.Fatalf("public mapping lost or models renamed: %+v", infos)
	}
	if infos[0].ModelCapabilities["local"][0] != model.ModelCapabilityImage || infos[0].ImageOutputCapabilities["local"].Formats[0] != model.ImageOutputFormatPNG || infos[0].ImageQualityCapabilities["local"].Values[0] != "high" {
		t.Fatalf("local declarations changed: %+v", infos[0])
	}
	if _, ok := infos[0].ImageOutputCapabilities["upstream"]; ok {
		t.Fatal("upstream name leaked into local capability keys")
	}
}

func TestPublicAvailableModelsAndDefaultImageModelKeepCustomLocalAlias(t *testing.T) {
	channel := normalizeModelChannel(model.ModelChannel{ID: "rolldek", Enabled: true, BaseURL: "https://api-cn.rolldek.com", ModelMap: map[string]string{"我的高质图": "gpt-image-2.5-sunburst"}})
	if !reflect.DeepEqual(channel.Models, []string{"我的高质图"}) {
		t.Fatalf("custom mapping key was not joined into channel models: %+v", channel.Models)
	}
	if !reflect.DeepEqual(enabledChannelModels([]model.ModelChannel{channel}), []string{"我的高质图"}) {
		t.Fatalf("available models missing custom alias: %+v", enabledChannelModels([]model.ModelChannel{channel}))
	}
	setting := normalizePublicSettingWithChannels(model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{AvailableModels: []string{"我的高质图"}}}, []model.ModelChannel{channel})
	if setting.ModelChannel.DefaultImageModel != "我的高质图" {
		t.Fatalf("default image model lost custom alias: %q", setting.ModelChannel.DefaultImageModel)
	}
}
