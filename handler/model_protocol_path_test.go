package handler

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestModelProtocolAdapterRegistration(t *testing.T) {
	want := map[string]bool{
		"openai": true, "gemini": true, "grok2api": true, "xai": true,
		"metaso": true, "apimart": true, "kie": true, "mimo": true,
		"ark": true,
	}
	seen := map[string]bool{}
	for _, adapter := range builtinAIProtocols {
		seen[adapter.id] = true
	}
	for id := range want {
		if !seen[id] {
			t.Fatalf("protocol %q is not registered", id)
		}
	}
}

func TestModelProtocolPathPrecedence(t *testing.T) {
	tests := []struct {
		name, protocol, baseURL, model, path, want string
	}{
		{"Gemini chat", "gemini", "", "gemini-test", "/chat/completions", "/v1beta/models/gemini-test:streamGenerateContent?alt=sse"},
		{"Gemini operation", "gemini", "", "veo", "/videos/operations/task", "/v1beta/operations/task"},
		{"Metaso create", "metaso", "https://api.kie.ai", "MiniMax-H3", "/videos", "/v2/video_generation"},
		{"KIE before APIMart", "apimart", "https://api.kie.ai", "future-model", "/videos", "/jobs/createTask"},
		{"KIE model marker", "apimart", "", "vendor/kie/model", "/videos", "/jobs/createTask"},
		{"APIMart video", "apimart", "", "future-model", "/videos", "/videos/generations"},
		{"APIMart image edit", "apimart", "", "gpt-image-2", "/images/edits", "/images/generations"},
		{"Grok2API video", "grok2api", "", "future-model", "/videos", "/videos/generations"},
		{"xAI video", "xai", "", "future-model", "/videos", "/videos/generations"},
		{"xAI Base URL video", "openai", "https://api.x.ai", "custom-model", "/videos", "/videos/generations"},
		{"Ark Seedance create", "ark", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seedance-2.0", "/videos", "/contents/generations/tasks"},
		{"Ark Seedance poll", "ark", "https://ark.cn-beijing.volces.com/api/plan/v3", "doubao-seedance-2.0", "/videos/task a?b", "/contents/generations/tasks/task a?b"},
		{"OpenAI passthrough", "openai", "", "future-model", "/responses", "/responses"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			channel := model.ModelChannel{Protocol: test.protocol, BaseURL: test.baseURL}
			if got := resolveAIProtocolPath(channel, test.model, test.path); got != test.want {
				t.Fatalf("path = %q, want %q", got, test.want)
			}
		})
	}
}

func TestModelProtocolURLHooks(t *testing.T) {
	tests := []struct {
		name, protocol, baseURL, model, path, want string
	}{
		{"default version", "openai", " https://api.example/ ", "model", "/models", "https://api.example/v1/models"},
		{"existing version", "openai", "https://api.example/v1/", "model", "/videos", "https://api.example/v1/videos"},
		{"Gemini version", "gemini", "https://api.example/v1beta/", "model", "/v1beta/models/model:generateContent", "https://api.example/v1beta/models/model:generateContent"},
		{"Metaso no version", "metaso", "https://api.example/", "MiniMax-H3", "/v2/video_generation", "https://api.example/v2/video_generation"},
		{"Agnes custom URL", "openai", "https://api.example/v1/", "agnes-video-2.5", "/videos/video_a b", "https://api.example/agnesapi?model_name=agnes-video-2.5&video_id=video_a+b"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			channel := model.ModelChannel{Protocol: test.protocol, BaseURL: test.baseURL}
			if got := resolveAIProtocolURL(channel, test.model, test.path); got != test.want {
				t.Fatalf("URL = %q, want %q", got, test.want)
			}
		})
	}
}
