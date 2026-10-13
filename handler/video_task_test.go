package handler

import (
	"bytes"
	"mime/multipart"
	"testing"
)

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
		if got := readAIRequestCount([]byte(item.body), "application/json", false); got != item.want {
			t.Errorf("count for %s = %d, want %d", item.body, got, item.want)
		}
	}
}

func TestVideoCountChargeMultiplier(t *testing.T) {
	for _, item := range []struct {
		body string
		want int
	}{
		{`{"seconds":5}`, 5},
		{`{"duration":10}`, 10},
		{`{"parameters":{"durationSeconds":-1}}`, 15},
		{`{"num_frames":121,"frame_rate":24}`, 5},
		{`{}`, 1},
	} {
		if got := readAIRequestCount([]byte(item.body), "application/json", true); got != item.want {
			t.Errorf("video count for %s = %d, want %d", item.body, got, item.want)
		}
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("duration", "7")
	_ = writer.WriteField("seconds", "0")
	_ = writer.Close()
	if got := readAIRequestCount(body.Bytes(), writer.FormDataContentType(), true); got != 7 {
		t.Fatalf("multipart video count = %d, want 7", got)
	}
}
