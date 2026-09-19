package service

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestImageGenerationSummaryKeepsSmallReferencesOnly(t *testing.T) {
	raw := json.RawMessage(`{"id":"log-1","prompt":"forest","images":[{"id":"img-1","storageKey":"server:media-1","dataUrl":"data:image/png;base64,AAAA"}],"references":[{"dataUrl":"data:image/png;base64,BBBB"}],"task":{"id":"task-1","response_body":"data:image/png;base64,CCCC","image_url":"/api/files/media-1/content"},"errorDetails":["long"]}`)
	summary := imageGenerationSummary(raw)
	if summary == "" || strings.Contains(summary, "base64") || strings.Contains(summary, "response_body") || strings.Contains(summary, "errorDetails") {
		t.Fatalf("summary leaked inline media: %s", summary)
	}
	var parsed struct {
		Images []struct {
			DataURL string `json:"dataUrl"`
		} `json:"images"`
	}
	if err := json.Unmarshal([]byte(summary), &parsed); err != nil || len(parsed.Images) != 1 || parsed.Images[0].DataURL != "/api/files/media-1/content" {
		t.Fatalf("missing durable image URL: %s, %v", summary, err)
	}
}

func TestImageLogServerKeys(t *testing.T) {
	keys := imageLogServerKeys(json.RawMessage(`{"images":[{"storageKey":"server:one"},{"storageKey":"image:local"}],"references":[{"storageKey":"server:one"},{"storageKey":"server:two"}]}`))
	if len(keys) != 2 || keys[0] != "server:one" || keys[1] != "server:two" {
		t.Fatalf("server keys = %#v", keys)
	}
}
