package handler

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestModelProtocolGrokMediaNormalizationForBothProtocols(t *testing.T) {
	for _, protocol := range []string{"grok2api", "xai"} {
		t.Run(protocol, func(t *testing.T) {
			channel := model.ModelChannel{Protocol: protocol, BaseURL: "https://upstream.invalid"}
			cases := []struct {
				name, path, body, want string
			}{
				{
					name: "image",
					path: "/images/generations",
					body: `{"model":"inner","prompt":"scene","image_urls":["https://media.invalid/source.png"],"quality":"high"}`,
					want: `{"model":"grok-imagine-image","prompt":"scene","image":{"url":"https://media.invalid/source.png"}}`,
				},
				{
					name: "edit",
					path: "/images/edits",
					body: `{"prompt":"scene","image":["https://media.invalid/source.png"],"size":"2048x2048"}`,
					want: `{"model":"grok-imagine-image-edit","prompt":"scene","image":{"url":"https://media.invalid/source.png"}}`,
				},
				{
					name: "video",
					path: "/videos/generations",
					body: `{"prompt":"scene","image":"https://media.invalid/source.png","duration":"6","resolution":"high"}`,
					want: `{"model":"grok-imagine-video","prompt":"scene","duration":6,"resolution":"1080p","image":{"url":"https://media.invalid/source.png"}}`,
				},
				{
					name: "tts",
					path: "/tts",
					body: `{"input":" hello ","voice":"eve","response_format":"mp3"}`,
					want: `{"model":"grok-voice-latest","text":"hello","voice_id":"eve","language":"en","output_format":{"codec":"mp3"}}`,
				},
			}
			for _, test := range cases {
				t.Run(test.name, func(t *testing.T) {
					path := test.path
					got, provider, err := prepareAIProtocolRequest(aiProtocolRequest{
						mode: aiProtocolProxyRequest, body: []byte(test.body), contentType: "application/json",
						modelName: map[string]string{"/images/generations": "grok-imagine-image", "/images/edits": "grok-imagine-image-edit", "/videos/generations": "grok-imagine-video", "/tts": "grok-voice-latest"}[path], channel: channel, endpoint: path, path: path,
					})
					if err != nil || provider != "grok2api" || got.failureLabel != "Grok/xAI" {
						t.Fatalf("provider=%q label=%q error=%v", provider, got.failureLabel, err)
					}
					assertModelProtocolJSON(t, got.body, test.want)
				})
			}
		})
	}
}

func TestModelProtocolBaseURLRecognitionAndProviderPriority(t *testing.T) {
	baseURLChannel := model.ModelChannel{Protocol: "openai", BaseURL: "https://gateway.api.x.ai/v1"}
	got, provider, err := prepareAIProtocolRequest(aiProtocolRequest{
		mode: aiProtocolProxyRequest, body: []byte(`{"prompt":"scene"}`), contentType: "application/json",
		modelName: "custom-model", channel: baseURLChannel, endpoint: "/images/generations", path: "/images/generations",
	})
	if err != nil || provider != "grok2api" || got.failureLabel != "Grok/xAI" {
		t.Fatalf("Base URL recognition provider=%q label=%q error=%v", provider, got.failureLabel, err)
	}

	for _, test := range []struct {
		name, protocol, baseURL, path, wantProvider string
	}{
		{"KIE priority", "kie", "https://gateway.api.x.ai", "/jobs/createTask", "kie"},
		{"APIMart priority", "apimart", "https://gateway.api.x.ai", "/videos/generations", "apimart"},
	} {
		t.Run(test.name, func(t *testing.T) {
			prepared, provider, err := prepareAIProtocolRequest(aiProtocolRequest{
				mode: aiProtocolProxyRequest, body: []byte(`{"prompt":"scene"}`), contentType: "application/json",
				modelName: "future-model", channel: model.ModelChannel{Protocol: test.protocol, BaseURL: test.baseURL}, endpoint: "/videos", path: test.path,
			})
			if err != nil || provider != test.wantProvider || prepared.failureLabel == "Grok/xAI" {
				t.Fatalf("provider=%q label=%q error=%v", provider, prepared.failureLabel, err)
			}
		})
	}
}

func TestModelProtocolPreparationLeavesUnmatchedRequestsUntouched(t *testing.T) {
	body := []byte(`not JSON`)
	input := aiProtocolRequest{
		mode: aiProtocolProxyRequest, body: body, contentType: "text/plain", modelName: "future-model",
		channel: model.ModelChannel{Protocol: "openai"}, endpoint: "/chat/completions", path: "/chat/completions",
	}
	got, provider, err := prepareAIProtocolRequest(input)
	if err != nil || provider != "" || !reflect.DeepEqual(got.body, body) || got.path != input.path {
		t.Fatalf("got %#v provider=%q error=%v", got, provider, err)
	}
}

func assertModelProtocolJSON(t *testing.T, got []byte, want string) {
	t.Helper()
	var gotValue, wantValue any
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatalf("got invalid JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(want), &wantValue); err != nil {
		t.Fatalf("want invalid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("got %s, want %s", got, want)
	}
}
