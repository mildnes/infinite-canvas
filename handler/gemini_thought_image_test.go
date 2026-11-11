package handler

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// 移植自上游 a166ac8：Gemini 的 thinking 过程会以 {"thought": true, "inlineData": {...}}
// 返回中间草图，不能当正式结果。若不过滤，模型同时返回思考图和正式图时会取错。
//
// 判据：只有【同时】满足 thought==true 且带 inlineData 的 part 才排除；
// thought==false 或没有 thought 字段的正常图片必须保留。

func thoughtImagePayload(thoughtField any, data string) []byte {
	part := map[string]any{
		"inlineData": map[string]any{"mimeType": "image/png", "data": data},
	}
	if thoughtField != nil {
		part["thought"] = thoughtField
	} else {
		delete(part, "thought")
	}
	payload, _ := json.Marshal(map[string]any{
		"candidates": []any{map[string]any{
			"content": map[string]any{"role": "model", "parts": []any{part}},
		}},
	})
	return payload
}

func TestGeminiThoughtImagesAreExcluded(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nfake"))

	t.Run("thought_true_is_excluded", func(t *testing.T) {
		_, _, _, err := imageURLsFromAIResponse(thoughtImagePayload(true, data), "application/json", true, false)
		if err == nil {
			t.Fatal("thought=true 的图片必须被排除，实际被当成结果返回了")
		}
		if err.Error() != "图片接口没有返回图片" {
			t.Fatalf("排除后应报没有返回图片，实际: %v", err)
		}
	})

	t.Run("thought_false_is_kept_guard", func(t *testing.T) {
		urls, _, _, err := imageURLsFromAIResponse(thoughtImagePayload(false, data), "application/json", true, false)
		if err != nil || len(urls) != 1 {
			t.Fatalf("thought=false 是正常图，必须保留；实际 images=%d err=%v", len(urls), err)
		}
	})

	t.Run("no_thought_field_is_kept_guard", func(t *testing.T) {
		urls, _, _, err := imageURLsFromAIResponse(thoughtImagePayload(nil, data), "application/json", true, false)
		if err != nil || len(urls) != 1 {
			t.Fatalf("没有 thought 字段的图片必须保留；实际 images=%d err=%v", len(urls), err)
		}
	})

	t.Run("thought_and_normal_coexist_only_normal_kept", func(t *testing.T) {
		// 思考图 + 正式图同时返回：只能取正式图
		normal := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nnormal"))
		payload, _ := json.Marshal(map[string]any{
			"candidates": []any{map[string]any{
				"content": map[string]any{"role": "model", "parts": []any{
					map[string]any{"thought": true, "inlineData": map[string]any{"mimeType": "image/png", "data": data}},
					map[string]any{"inlineData": map[string]any{"mimeType": "image/png", "data": normal}},
				}},
			}},
		})
		urls, _, _, err := imageURLsFromAIResponse(payload, "application/json", true, false)
		if err != nil {
			t.Fatalf("应取到正式图，实际报错: %v", err)
		}
		if len(urls) != 1 {
			t.Fatalf("应只保留 1 张正式图，实际 %d 张", len(urls))
		}
		if urls[0] != "data:image/png;base64,"+normal {
			t.Fatal("取到的不是正式图，说明思考图没被正确排除")
		}
	})
}
