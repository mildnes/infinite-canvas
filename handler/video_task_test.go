package handler

import "testing"

func TestParseVideoTaskPayloadReadsNestedRelativeVideoURL(t *testing.T) {
	payload := []byte(`{
		"model":"grok-imagine-video",
		"status":"done",
		"video":{"url":"/v1/videos/video_example/content"}
	}`)

	parsed := parseVideoTaskPayload(payload, "grok-imagine-video")
	if got, want := parsed.VideoURL, "/v1/videos/video_example/content"; got != want {
		t.Fatalf("VideoURL = %q, want %q", got, want)
	}
	if got, want := parsed.Status, "completed"; got != want {
		t.Fatalf("Status = %q, want %q", got, want)
	}
}

func TestImageCountChargeMultiplier(t *testing.T) {
	for _, item := range []struct {
		body string
		want int
	}{
		{`{"model":"shared","n":3}`, 3},
		{`{"model":"shared","n":0}`, 1},
		{`{"model":"shared"}`, 1},
	} {
		if got := readAIRequestCount([]byte(item.body), "application/json"); got != item.want {
			t.Errorf("count for %s = %d, want %d", item.body, got, item.want)
		}
	}
}
