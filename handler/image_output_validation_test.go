package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestImageAlphaWarningsBeforeResponse(t *testing.T) {
	for _, transparent := range []bool{false, true} {
		img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
		if !transparent {
			for y := 0; y < 2; y++ {
				for x := 0; x < 2; x++ {
					img.SetNRGBA(x, y, color.NRGBA{R: 242, G: 242, B: 242, A: 255})
				}
			}
		}
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, img); err != nil {
			t.Fatal(err)
		}
		payload, _ := json.Marshal(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(encoded.Bytes())}}})
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(payload)
		}))
		request, _ := http.NewRequest(http.MethodPost, upstream.URL, nil)
		result := httptest.NewRecorder()
		copyAIResponse(result, request, model.ModelChannel{Protocol: "openai"}, aiLogContext{Model: "custom-model", ImageOutputFormat: "png-transparent", SkipLog: true}, nil)
		upstream.Close()
		if result.Code != 200 || !bytes.Equal(result.Body.Bytes(), payload) {
			t.Fatalf("media response changed: %s", result.Body.String())
		}
		want := "upstream-no-alpha"
		if transparent {
			want = ""
		}
		if got := result.Header().Get("X-Image-Output-Notice"); got != want {
			t.Fatalf("transparent=%v notice=%q want=%q", transparent, got, want)
		}
	}
}

func TestMultiImageAlphaAndUnreadableResult(t *testing.T) {
	var opaque bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.SetRGBA(0, 0, color.RGBA{A: 255})
	if err := png.Encode(&opaque, img); err != nil {
		t.Fatal(err)
	}
	var transparent bytes.Buffer
	if err := png.Encode(&transparent, image.NewNRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"data": []any{
		map[string]any{"b64_json": base64.StdEncoding.EncodeToString(transparent.Bytes())},
		map[string]any{"b64_json": base64.StdEncoding.EncodeToString(opaque.Bytes())},
	}})
	_, code := validateImageResponseAlpha(context.Background(), payload, "application/json")
	if code != "upstream-no-alpha" {
		t.Fatalf("code=%q", code)
	}
	_, code = validateImageResponseAlpha(context.Background(), []byte(`{"data":[{"url":"http://127.0.0.1/private.png"}]}`), "application/json")
	if code != "upstream-alpha-unverified" {
		t.Fatalf("private source must stay blocked: %q", code)
	}
}

func TestUndeclaredOutputNoticeKeepsOriginalRequest(t *testing.T) {
	body := []byte(`{"model":"custom-alias","prompt":"scene","quality":"max"}`)
	encoded, _, result, err := normalizeImageOutputFormatRequest(body, "application/json", model.ModelChannel{Protocol: "openai"}, "custom-alias", "/images/generations")
	if err != nil || !bytes.Equal(encoded, body) || result.NoticeCode != "undeclared" {
		t.Fatalf("body=%s result=%+v err=%v", encoded, result, err)
	}
	text := []byte(`{"model":"custom-alias","messages":[{"role":"user","content":"text only"}]}`)
	_, _, result, err = normalizeImageOutputFormatRequest(text, "application/json", model.ModelChannel{Protocol: "openai"}, "custom-alias", "/chat/completions")
	if err != nil || result.NoticeCode != "" {
		t.Fatalf("text requests must not get image warnings: %+v %v", result, err)
	}
	for _, body := range []string{
		`{"model":"custom-alias","modalities":["image","text"],"image_config":{"aspect_ratio":"1:1"}}`,
		`{"model":"custom-alias","modalities":["image"]}`,
	} {
		encoded, _, result, err := normalizeImageOutputFormatRequest([]byte(body), "application/json", model.ModelChannel{Protocol: "openai"}, "custom-alias", "/chat/completions")
		if err != nil || string(encoded) != body || result.NoticeCode != "undeclared" {
			t.Fatalf("image chat must preserve its body and report missing capability: %s %+v %v", encoded, result, err)
		}
	}
}

func TestDeclaredFormatsDoNotBypassGrokProtocolGuard(t *testing.T) {
	for _, protocol := range []string{"grok2api", "xai", "openai"} {
		channel := model.ModelChannel{Protocol: protocol, Models: []string{"grok-imagine-image-2.0"}, ImageOutputCapabilities: map[string]model.ImageOutputCapability{
			"grok-imagine-image-2.0": {Formats: []model.ImageOutputFormat{model.ImageOutputFormatPNGTransparent}, DefaultFormat: model.ImageOutputFormatPNGTransparent},
		}}
		body, _, result, err := normalizeImageOutputFormatRequest([]byte(`{"model":"grok-imagine-image-2.0","output_format":"png","background":"transparent","quality":"max"}`), "application/json", channel, "grok-imagine-image-2.0", "/images/generations")
		var payload map[string]any
		if err != nil || json.Unmarshal(body, &payload) != nil {
			t.Fatal(err)
		}
		if payload["output_format"] != nil || payload["background"] != nil || result.Format != "auto" || payload["quality"] != "max" {
			t.Fatalf("protocol guard bypassed: %s %+v", body, result)
		}
	}
}
