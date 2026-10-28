package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
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

func TestValidatedImageResponseLogCaptureIsBounded(t *testing.T) {
	for _, size := range []int{16 * 1024, 32 * 1024} {
		for _, transparent := range []bool{true, false} {
			name := fmt.Sprintf("%d-transparent=%t", size, transparent)
			t.Run(name, func(t *testing.T) {
				originalDir := config.Cfg.AILogDir
				config.Cfg.AILogDir = t.TempDir()
				t.Cleanup(func() {
					config.Cfg.AILogDir = originalDir
				})

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

				payload := []byte(fmt.Sprintf(
					`{"request_id":"capture-%d-%t","extra":{"keep":"visible"},"redact":"%s","data":[{"b64_json":"%s"}],"ordinary":"%s"}`,
					size, transparent, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 4096)),
					base64.StdEncoding.EncodeToString(encoded.Bytes()), strings.Repeat("x-", size/2),
				))
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write(payload)
				}))
				defer upstream.Close()

				request, err := http.NewRequest(http.MethodPost, upstream.URL, nil)
				if err != nil {
					t.Fatal(err)
				}
				result := httptest.NewRecorder()
				copyAIResponse(result, request, model.ModelChannel{Protocol: "openai"}, aiLogContext{
					Endpoint:          "/images/generations",
					Method:            http.MethodPost,
					Model:             "gpt-image-2",
					UserID:            "capture-user",
					ImageOutputFormat: string(model.ImageOutputFormatPNGTransparent),
				}, nil)

				if result.Code != http.StatusOK || !bytes.Equal(result.Body.Bytes(), payload) {
					t.Fatalf("client response changed: status=%d got=%d want=%d bytes", result.Code, result.Body.Len(), len(payload))
				}
				wantNotice := ""
				if !transparent {
					wantNotice = "upstream-no-alpha"
				}
				if got := result.Header().Get("X-Image-Output-Notice"); got != wantNotice {
					t.Fatalf("transparent=%v notice=%q want=%q", transparent, got, wantNotice)
				}

				files, err := filepath.Glob(filepath.Join(config.Cfg.AILogDir, "ai-calls-*.log"))
				if err != nil {
					t.Fatal(err)
				}
				if len(files) != 1 {
					t.Fatalf("log file count = %d, want 1", len(files))
				}
				raw, err := os.ReadFile(files[0])
				if err != nil {
					t.Fatal(err)
				}
				var item model.AICallLog
				if err := json.Unmarshal(bytes.TrimSpace(raw), &item); err != nil {
					t.Fatal(err)
				}
				if len(item.ResponseBody) > service.AILogResponseCaptureLimit {
					t.Fatalf("response capture length = %d, want <= %d", len(item.ResponseBody), service.AILogResponseCaptureLimit)
				}
				if !strings.Contains(item.ResponseBody, `"extra":{"keep":"visible"}`) {
					t.Fatalf("ordinary JSON field was dropped: %q", item.ResponseBody)
				}
				if !strings.Contains(item.ResponseBody, "[redacted large base64/string]") {
					t.Fatalf("redaction placeholder missing: %q", item.ResponseBody)
				}
				if strings.Contains(item.ResponseBody, strings.Repeat("q83", 128)) {
					t.Fatal("response capture retained a long base64 fragment")
				}
			})
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

func TestOpaquePNGResponseCarriesFormatHeader(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString([]byte("opaque-bytes"))}}})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(payload)
	}))
	defer upstream.Close()
	request, _ := http.NewRequest(http.MethodPost, upstream.URL, nil)
	result := httptest.NewRecorder()
	copyAIResponse(result, request, model.ModelChannel{Protocol: "openai"}, aiLogContext{Model: "gpt-image-2", ImageOutputFormat: string(model.ImageOutputFormatPNG), SkipLog: true}, nil)
	if result.Code != 200 {
		t.Fatalf("status = %d body=%s", result.Code, result.Body.String())
	}
	if got := result.Header().Get("X-Image-Output-Format"); got != "png" {
		t.Fatalf("format header = %q, want png", got)
	}
	if got := result.Header().Get("X-Image-Output-Notice"); got != "" {
		t.Fatalf("unexpected notice header: %q", got)
	}
}
