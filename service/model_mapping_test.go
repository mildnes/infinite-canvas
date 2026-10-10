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
