package handler

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestImageCandidateTextRegression(t *testing.T) {
	dataURL := inlineImageDataURL(t, 1)
	encoded := strings.SplitN(dataURL, ",", 2)[1]
	payload := func(value any) []byte {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	for _, sample := range []struct {
		name    string
		body    []byte
		wantURL string
	}{
		{"01_text_test", payload(map[string]any{"text": "test"}), ""},
		{"02_text_done", payload(map[string]any{"text": "done"}), ""},
		{"03_text_base64_hello", payload(map[string]any{"text": "aGVsbG8="}), ""},
		{"04_text_OK_guard", payload(map[string]any{"text": "OK"}), ""},
		{"05_markdown_JPEG_guard", geminiInlineTextPayload("![image](" + dataURL + ")"), dataURL},
		{"06_gemini_inlineData_guard", payload(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{
			map[string]any{"inlineData": map[string]any{"mimeType": "image/jpeg", "data": encoded}},
		}}}}}), dataURL},
		{"07_openai_b64_json_guard", payload(map[string]any{"data": []any{map[string]any{"b64_json": encoded}}}), dataURL},
		{"08_https_URL_guard", payload(map[string]any{"data": []any{map[string]any{"url": "https://example.com/a.png"}}}), "https://example.com/a.png"},
		{"09_raw_JPEG_base64_guard", payload(map[string]any{"text": encoded}), dataURL},
		{"10_text_success_guard", payload(map[string]any{"text": "success"}), ""},
		{"11_text_abc123_guard", payload(map[string]any{"text": "abc123"}), ""},
	} {
		t.Run(sample.name, func(t *testing.T) {
			urls, mimeType, size, err := imageURLsFromAIResponse(sample.body, "application/json", false, false)
			if sample.wantURL == "" {
				if err == nil || !strings.Contains(err.Error(), "图片接口没有返回图片") || len(urls) != 0 {
					t.Fatalf("actual images=%d MIME=%q bytes=%d error=%v; expected images=0 error=图片接口没有返回图片", len(urls), mimeType, size, err)
				}
				t.Logf("images=0 error=%v", err)
				return
			}
			if err != nil || len(urls) != 1 || urls[0] != sample.wantURL {
				t.Fatalf("actual images=%d error=%v; expected one unchanged image reference", len(urls), err)
			}
			if strings.HasPrefix(sample.wantURL, "https://") {
				if mimeType != "" || size != 0 {
					t.Fatalf("URL candidate unexpectedly decoded: MIME=%q bytes=%d", mimeType, size)
				}
			} else if mimeType != "image/jpeg" || size <= 0 {
				t.Fatalf("JPEG candidate lost its MIME or bytes: MIME=%q bytes=%d", mimeType, size)
			}
			t.Logf("images=1 MIME=%q bytes=%d", mimeType, size)
		})
	}
}
