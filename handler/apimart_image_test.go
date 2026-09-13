package handler

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestNormalizeAPIMartGrokImage2OfficialBody(t *testing.T) {
	body := []byte(`{"model":"grok-imagine-image-2.0","prompt":"a cat","n":2,"size":"6272x2688","quality":"max"}`)
	encoded, contentType, err := normalizeAPIMartImageBody(body, "application/json", "grok-imagine-image-2.0", model.ModelChannel{})
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "application/json" {
		t.Fatalf("content type = %q", contentType)
	}
	payload := testGrok2APIRecord(t, encoded)
	for key, want := range map[string]any{
		"model":        "grok-imagine-image-2.0",
		"prompt":       "a cat",
		"n":            float64(2),
		"aspect_ratio": "20:9",
		"resolution":   "2k",
		"quality":      "medium",
	} {
		if got := payload[key]; got != want {
			t.Fatalf("payload[%q] = %#v, want %#v", key, got, want)
		}
	}
	if _, ok := payload["size"]; ok {
		t.Fatalf("official async Grok request must not keep size: %#v", payload)
	}
}

func TestNormalizeAPIMartGrokImage2OfficialEditDropsQuality(t *testing.T) {
	body := []byte(`{"model":"grok-imagine-image-2.0","prompt":"make it blue","size":"1024x1024","quality":"high","images":[{"url":"https://example.com/source.png"}]}`)
	encoded, _, err := normalizeAPIMartImageBody(body, "application/json", "grok-imagine-image-2.0", model.ModelChannel{})
	if err != nil {
		t.Fatal(err)
	}
	payload := testGrok2APIRecord(t, encoded)
	if payload["aspect_ratio"] != "1:1" || payload["resolution"] != "1k" {
		t.Fatalf("unexpected official edit dimensions: %#v", payload)
	}
	if _, ok := payload["quality"]; ok {
		t.Fatalf("official Grok edit must not keep quality: %#v", payload)
	}
	refs, ok := payload["image_urls"].([]any)
	if !ok || len(refs) != 1 || refs[0] != "https://example.com/source.png" {
		t.Fatalf("image_urls = %#v", payload["image_urls"])
	}
}

func TestNormalizeAPIMartGrokImage2ExtKeepsSizeProtocol(t *testing.T) {
	body := []byte(`{"model":"grok-imagine-2.0-ext","prompt":"a cat","size":"16:9","resolution":"quality"}`)
	encoded, _, err := normalizeAPIMartImageBody(body, "application/json", "grok-imagine-2.0-ext", model.ModelChannel{})
	if err != nil {
		t.Fatal(err)
	}
	payload := testGrok2APIRecord(t, encoded)
	if payload["size"] != "16:9" {
		t.Fatalf("ext model size = %#v", payload["size"])
	}
	if _, ok := payload["aspect_ratio"]; ok {
		t.Fatalf("ext model must not switch to official aspect_ratio protocol: %#v", payload)
	}
}
