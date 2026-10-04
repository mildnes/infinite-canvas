package service

import (
	"reflect"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestResolveImageOutputCapability(t *testing.T) {
	tests := []struct {
		name      string
		channel   model.ModelChannel
		modelName string
		want      model.ImageOutputCapability
		ok        bool
	}{
		{
			name:      "OpenAI GPT image formats",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolOpenAI},
			modelName: "gpt-image-2",
			want: model.ImageOutputCapability{
				Formats:       []model.ImageOutputFormat{model.ImageOutputFormatPNGTransparent, model.ImageOutputFormatJPEG},
				DefaultFormat: model.ImageOutputFormatPNGTransparent,
			},
			ok: true,
		},
		{
			name:      "OpenAI image snapshot",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolOpenAI},
			modelName: "gpt-image-2.5-flare-2026-10-01",
			want: model.ImageOutputCapability{
				Formats:       []model.ImageOutputFormat{model.ImageOutputFormatPNGTransparent, model.ImageOutputFormatJPEG},
				DefaultFormat: model.ImageOutputFormatPNGTransparent,
			},
			ok: true,
		},
		{
			name:      "OpenAI GPT Image 1.5 model family",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolOpenAI},
			modelName: "gpt-image-1.5",
			want: model.ImageOutputCapability{
				Formats:       []model.ImageOutputFormat{model.ImageOutputFormatPNGTransparent, model.ImageOutputFormatJPEG},
				DefaultFormat: model.ImageOutputFormatPNGTransparent,
			},
			ok: true,
		},
		{
			name:      "OpenAI unknown lookalike is excluded",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolOpenAI},
			modelName: "other-gpt-image-2",
		},
		{
			name:      "OpenAI unknown suffix is excluded",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolOpenAI},
			modelName: "gpt-image-2.5-unknown",
		},
		{
			name:      "APIMart GPT Image only declares JPEG",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolAPIMart},
			modelName: "gpt-image-2-official",
			want:      model.ImageOutputCapability{Formats: []model.ImageOutputFormat{model.ImageOutputFormatJPEG}, DefaultFormat: model.ImageOutputFormatJPEG},
			ok:        true,
		},
		{
			name:      "APIMart unofficial lookalike is excluded",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolAPIMart},
			modelName: "gpt-image-2-unofficial",
		},
		{
			name:      "APIMart Seedream pro uses its explicit unsupported output boundary",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolAPIMart},
			modelName: "seedream-5-0-pro",
		},
		{
			name:      "APIMart Seedream lite uses its output format boundary",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolAPIMart},
			modelName: "seedream-5-0-lite",
			want:      model.ImageOutputCapability{Formats: []model.ImageOutputFormat{model.ImageOutputFormatJPEG}, DefaultFormat: model.ImageOutputFormatJPEG},
			ok:        true,
		},
		{
			name:      "KIE JPEG format",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolKIE},
			modelName: "qwen2/text-to-image",
			want:      model.ImageOutputCapability{Formats: []model.ImageOutputFormat{model.ImageOutputFormatJPEG}, DefaultFormat: model.ImageOutputFormatJPEG},
			ok:        true,
		},
		{
			name:      "xAI is not inferred as OpenAI GPT Image",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolXAI, BaseURL: "https://api.x.ai"},
			modelName: "gpt-image-1",
		},
		{
			name:      "OpenAI compatible Grok URL is excluded",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolOpenAI, BaseURL: "https://api.x.ai/v1"},
			modelName: "gpt-image-1",
		},
		{
			name:      "unsupported protocol stays automatic",
			channel:   model.ModelChannel{Protocol: ModelChannelProtocolGemini},
			modelName: "gemini-3-pro-image-preview",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := ResolveImageOutputCapability(test.channel, test.modelName)
			if ok != test.ok {
				t.Fatalf("supported = %v, want %v", ok, test.ok)
			}
			if ok && !reflect.DeepEqual(got, test.want) {
				t.Fatalf("capability = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestPublicChannelInfosIncludesModelOutputCapabilities(t *testing.T) {
	got := publicChannelInfos([]model.ModelChannel{
		{
			ID:       "openai-channel",
			Protocol: ModelChannelProtocolOpenAI,
			BaseURL:  "https://api.openai.com/v1",
			APIKey:   "secret",
			Models:   []string{"gpt-image-2", "gpt-4.1"},
			Enabled:  true,
		},
	}, [][]string{{"gpt-image-2", "gpt-4.1"}}...)
	if len(got) != 1 {
		t.Fatalf("channels = %d, want 1", len(got))
	}
	if len(got[0].ImageOutputCapabilities) != 1 {
		t.Fatalf("image output capabilities = %#v, want only image model", got[0].ImageOutputCapabilities)
	}
	if _, ok := got[0].ImageOutputCapabilities["gpt-image-2"]; !ok {
		t.Fatal("public channel is missing GPT Image output capability")
	}
	if _, ok := got[0].ImageOutputCapabilities["gpt-4.1"]; ok {
		t.Fatal("text model unexpectedly has image output capability")
	}
}
