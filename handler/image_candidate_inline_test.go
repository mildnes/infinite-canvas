package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"reflect"
	"strings"
	"testing"
)

const inlineImageTestMaxCount = 8

func inlineImageDataURL(t *testing.T, index uint8) string {
	t.Helper()
	picture := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	picture.SetNRGBA(0, 0, color.NRGBA{R: index * 19, G: 31, B: 127, A: 255})
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, picture, &jpeg.Options{Quality: 100}); err != nil {
		t.Fatal(err)
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
}

func geminiInlineTextPayload(texts ...string) []byte {
	parts := make([]any, 0, len(texts))
	for _, text := range texts {
		parts = append(parts, map[string]any{"text": text})
	}
	payload, _ := json.Marshal(map[string]any{
		"candidates": []any{map[string]any{
			"content":      map[string]any{"role": "model", "parts": parts},
			"finishReason": "STOP",
		}},
	})
	return payload
}

func TestImageCandidateInlineAcceptance(t *testing.T) {
	first, second := inlineImageDataURL(t, 1), inlineImageDataURL(t, 2)
	many := make([]string, inlineImageTestMaxCount+3)
	markdown := make([]string, len(many))
	for index := range many {
		many[index] = inlineImageDataURL(t, uint8(index+1))
		markdown[index] = fmt.Sprintf("![image%d](%s)", index, many[index])
	}
	encoded := strings.SplitN(first, ",", 2)[1]
	inlineData, _ := json.Marshal(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{
		map[string]any{"inlineData": map[string]any{"mimeType": "image/jpeg", "data": encoded}},
	}}}}})
	openAI, _ := json.Marshal(map[string]any{"data": []any{map[string]any{"b64_json": encoded}}})
	for _, sample := range []struct {
		name    string
		payload []byte
		want    []string
	}{
		{"01_markdown_jpeg", geminiInlineTextPayload("![image](" + first + ")"), []string{first}},
		{"02_bare_url_in_prose", geminiInlineTextPayload("这是为你生成的图片：\n" + first + "\n希望你喜欢。"), []string{first}},
		{"03_two_markdown_images", geminiInlineTextPayload("![one](" + first + ")\n![two](" + second + ")"), []string{first, second}},
		{"04_duplicate_across_parts", geminiInlineTextPayload("![image]("+first+")", "同一图片："+first), []string{first}},
		{"05_eleven_images_capped_at_eight", geminiInlineTextPayload(strings.Join(markdown, "\n")), many[:inlineImageTestMaxCount]},
		{"06_standard_gemini_inlineData_guard", inlineData, []string{first}},
		{"07_openai_b64_json_guard", openAI, []string{first}},
		{"08_plain_text_guard", geminiInlineTextPayload("生成完成，但这里没有图片。"), nil},
	} {
		t.Run(sample.name, func(t *testing.T) {
			got, mime, size, err := imageURLsFromAIResponse(sample.payload, "application/json", true, false)
			if sample.want == nil {
				if err == nil || !strings.Contains(err.Error(), "没有返回图片") {
					t.Fatalf("actual error=%v expected=图片接口没有返回图片", err)
				}
				t.Logf("no-image error: %v", err)
				return
			}
			if err != nil || !reflect.DeepEqual(got, sample.want) {
				t.Fatalf("actual images=%d error=%v expected images=%d matching original data URLs", len(got), err, len(sample.want))
			}
			if mime != "image/jpeg" || size <= 0 {
				t.Fatalf("candidate was not decoded: mime=%q bytes=%d", mime, size)
			}
			decoded, decodeErr := base64.StdEncoding.DecodeString(strings.SplitN(got[0], ",", 2)[1])
			if decodeErr != nil {
				t.Fatal(decodeErr)
			}
			if _, err := jpeg.Decode(bytes.NewReader(decoded)); err != nil {
				t.Fatalf("fixture must contain actual JPEG bytes: %v", err)
			}
			t.Logf("images=%d MIME=%s firstBytes=%d", len(got), mime, size)
		})
	}
}

func TestImageCandidateInlineBoundaries(t *testing.T) {
	first := inlineImageDataURL(t, 1)
	t.Run("collectAll_false_returns_first_image", func(t *testing.T) {
		second := inlineImageDataURL(t, 2)
		got, _, _, err := imageURLsFromAIResponse(geminiInlineTextPayload("![one]("+first+") ![two]("+second+")"), "application/json", false, false)
		if err != nil || !reflect.DeepEqual(got, []string{first}) {
			t.Fatalf("actual images=%d err=%v expected first image only", len(got), err)
		}
	})
	t.Run("inline_cap_applies_across_parts", func(t *testing.T) {
		texts, want := []string{}, []string{}
		for index := 0; index < inlineImageTestMaxCount+3; index++ {
			dataURL := inlineImageDataURL(t, uint8(index+1))
			texts = append(texts, "![image]("+dataURL+")")
			if index < inlineImageTestMaxCount {
				want = append(want, dataURL)
			}
		}
		got, _, _, err := imageURLsFromAIResponse(geminiInlineTextPayload(texts...), "application/json", true, false)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("actual images=%d err=%v expected first %d distinct images across parts", len(got), err, len(want))
		}
	})
	t.Run("duplicate_matches_do_not_use_up_distinct_image_budget", func(t *testing.T) {
		second := inlineImageDataURL(t, 2)
		text := strings.Repeat("![one]("+first+") ", 12) + "![two](" + second + ")"
		got, _, _, err := imageURLsFromAIResponse(geminiInlineTextPayload(text), "application/json", true, false)
		if err != nil || !reflect.DeepEqual(got, []string{first, second}) {
			t.Fatalf("actual images=%d err=%v expected two distinct images", len(got), err)
		}
	})
	t.Run("recursion_limit_remains_seven", func(t *testing.T) {
		for _, sample := range []struct {
			value string
			count int
		}{{first, 1}, {"![image](" + first + ")", 1}} {
			if got := collectImageCandidates(sample.value, 8, false); len(got) != 0 {
				t.Fatalf("depth 8 actual=%d expected=0", len(got))
			}
			if got := collectImageCandidates(sample.value, 7, false); len(got) != sample.count {
				t.Fatalf("depth 7 actual=%d expected=%d", len(got), sample.count)
			}
		}
	})
	t.Run("malformed_inline_data_still_fails_decode", func(t *testing.T) {
		_, _, _, err := imageURLsFromAIResponse(geminiInlineTextPayload("![image](data:image/jpeg;base64,A)"), "application/json", true, false)
		if err == nil || !strings.Contains(err.Error(), "没有返回图片") {
			t.Fatalf("invalid base64 actual error=%v expected no-image error", err)
		}
	})
	t.Run("standard_and_markdown_images_coexist", func(t *testing.T) {
		second := inlineImageDataURL(t, 2)
		payload, _ := json.Marshal(map[string]any{"data": []any{map[string]any{"url": first}}, "text": "![second](" + second + ")"})
		got, _, _, err := imageURLsFromAIResponse(payload, "application/json", true, false)
		if err != nil || !reflect.DeepEqual(got, []string{first, second}) {
			t.Fatalf("mixed response actual=%d err=%v expected=2", len(got), err)
		}
	})
	t.Run("server_sent_events_use_same_inline_parser", func(t *testing.T) {
		payload := []byte("data: " + string(geminiInlineTextPayload("![image]("+first+")")) + "\n\ndata: [DONE]\n\n")
		got, _, _, err := imageURLsFromAIResponse(payload, "text/event-stream", true, false)
		if err != nil || !reflect.DeepEqual(got, []string{first}) {
			t.Fatalf("SSE response actual=%d err=%v expected=1", len(got), err)
		}
	})
	t.Run("standard_collectAll_is_not_capped_by_inline_limit", func(t *testing.T) {
		items := make([]any, 0, inlineImageTestMaxCount+3)
		for index := 0; index < inlineImageTestMaxCount+3; index++ {
			items = append(items, map[string]any{"url": inlineImageDataURL(t, uint8(index+1))})
		}
		payload, _ := json.Marshal(map[string]any{"data": items})
		got, _, _, err := imageURLsFromAIResponse(payload, "application/json", true, false)
		if err != nil || len(got) != len(items) {
			t.Fatalf("standard collectAll actual=%d err=%v expected=%d", len(got), err, len(items))
		}
	})
}
