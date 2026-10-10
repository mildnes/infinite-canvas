package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestDirectModelMappingUsesLocalOutputAndQualityDeclarations(t *testing.T) {
	for _, endpoint := range []string{"/images/generations", "/images/edits"} {
		channel := directAIChannelInput{Protocol: "apimart", BaseURL: "https://api.apimart.ai", Models: []string{"local"}, ModelMap: map[string]string{"local": "gpt-image-2"},
			ImageOutputCapabilities: map[string]model.ImageOutputCapability{
				"local":       {Formats: []model.ImageOutputFormat{model.ImageOutputFormatPNGTransparent}},
				"gpt-image-2": {Formats: []model.ImageOutputFormat{}},
			},
			ImageQualityCapabilities: map[string]model.ImageQualityCapability{
				"local":       {Values: []string{"high"}, Map: map[string]string{"best": "high"}},
				"gpt-image-2": {Values: []string{}},
			},
		}
		plan, err := prepareDirectAIRequest(directAIRequestInput{Channel: channel, Model: "local", Endpoint: endpoint, Body: map[string]any{"model": "local", "prompt": "scene", "output_format": "png", "background": "transparent", "quality": "best"}})
		if err != nil {
			t.Fatal(err)
		}
		body := testDirectRecord(t, plan.Body)
		if body["model"] != "gpt-image-2" || body["quality"] != "high" || body["output_format"] != "png" || body["background"] != "transparent" || plan.ImageQuality != "high" || plan.ImageOutputFormat != "png-transparent" {
			t.Fatalf("mapping changed local declarations: %+v", plan)
		}
	}
}

func TestDirectModelMappingChainsKIEAliasesAndUsesMappedPath(t *testing.T) {
	for _, test := range []struct{ local, upstream, wantModel, wantPath string }{
		{"render", "seedream/seedream", "bytedance/seedream", "/jobs/createTask"},
		{"render", "grok-imagine-image-2-0/text-to-image", "grok-imagine-image-2-0/text-to-image", "/client/tasks"},
	} {
		plan, err := prepareDirectAIRequest(directAIRequestInput{Channel: directAIChannelInput{Protocol: "kie", BaseURL: "https://api.kie.ai", ModelMap: map[string]string{test.local: test.upstream}}, Model: test.local, Endpoint: "/images/generations", Body: map[string]any{"model": test.local, "prompt": "scene"}})
		if err != nil {
			t.Fatal(err)
		}
		if testDirectRecord(t, plan.Body)["model"] != test.wantModel || !strings.HasSuffix(plan.URL, test.wantPath) {
			t.Fatalf("mapping must precede KIE aliases/path: %+v", plan)
		}
	}
	channel := model.ModelChannel{Protocol: "gemini", ModelMap: map[string]string{"render": "gemini-3-pro-image-preview"}}
	if path := resolveAIProxyPath(channel, service.ResolveUpstreamModelName(channel, "render"), "/images/generations"); path != "/v1beta/models/gemini-3-pro-image-preview:generateContent" {
		t.Fatalf("Gemini path = %q", path)
	}
}

func TestRewriteAIRequestModelPreservesUnmappedAndSpecialBodies(t *testing.T) {
	for _, body := range []string{"{ \"model\": \"local\", \"n\": 1 }", "{\"contents\":[]}", "[1,2]", "{\"model\":{\"id\":1}}", "{\"model\":null}", "{\"model\":42}"} {
		original := []byte(body)
		got, err := rewriteAIRequestModel(original, "application/json", "local", "local")
		if err != nil || !bytes.Equal(got, original) {
			t.Fatalf("no mapping changed original bytes: %s %v", got, err)
		}
		if !strings.Contains(body, "\"local\"") {
			got, err = rewriteAIRequestModel(original, "application/json", "local", "upstream")
			if err != nil || !bytes.Equal(got, original) {
				t.Fatalf("special body changed: %s %v", got, err)
			}
		}
	}
}

func TestRewriteAIRequestModelMultipartPreservesFilesAndHeaders(t *testing.T) {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	_ = writer.WriteField("model", "local")
	_ = writer.WriteField("prompt", "local stays in prompt")
	file, _ := writer.CreateFormFile("image[]", "ref.png")
	original := []byte{0, 1, 255, 0, 17}
	_, _ = file.Write(original)
	_ = writer.Close()
	body, err := rewriteAIRequestModel(buffer.Bytes(), writer.FormDataContentType(), "local", "upstream")
	if err != nil {
		t.Fatal(err)
	}
	reader := multipart.NewReader(bytes.NewReader(body), writer.Boundary())
	form, err := reader.ReadForm(1024)
	if err != nil {
		t.Fatal(err)
	}
	defer form.RemoveAll()
	if form.Value["model"][0] != "upstream" || form.Value["prompt"][0] != "local stays in prompt" {
		t.Fatalf("fields changed: %+v", form.Value)
	}
	header := form.File["image[]"][0]
	stream, _ := header.Open()
	defer stream.Close()
	data, _ := io.ReadAll(stream)
	if !bytes.Equal(data, original) || header.Filename != "ref.png" || header.Header.Get("Content-Type") != "application/octet-stream" {
		t.Fatal("multipart media changed")
	}
}

func TestMappedProtocolVideoResponseAndCanvasTaskKeepLocalModel(t *testing.T) {
	channel := model.ModelChannel{Protocol: "kie", ModelMap: map[string]string{"local-video": "kling/text-to-video"}}
	requestPath := "/jobs/createTask"
	request, _ := http.NewRequest("POST", "https://api.kie.ai"+requestPath, nil)
	body := transformVideoCreatePayload([]byte("{\"code\":200,\"data\":{\"taskId\":\"task\"}}"), request, channel, "local-video")
	var result map[string]any
	_ = json.Unmarshal(body, &result)
	if result["model"] != "local-video" {
		t.Fatalf("upstream model escaped into task response: %s", body)
	}
	if service.CanvasImageTaskResponse(model.CanvasImageTask{Model: "local-image"})["model"] != "local-image" {
		t.Fatal("canvas task model must remain local")
	}
}

func TestVideoCreateMappingUsesUpstreamProtocolWithoutDoubleMapping(t *testing.T) {
	channel := model.ModelChannel{Protocol: "kie", ModelMap: map[string]string{"local-video": "kling/text-to-video", "kling/text-to-video": "unrelated"}}
	body := []byte("{\"model\":\"local-video\",\"prompt\":\"scene\",\"duration\":\"5\"}")
	upstream := service.ResolveUpstreamModelName(channel, "local-video")
	path := resolveAIProxyPath(channel, upstream, "/videos")
	encoded, _, err := normalizeVideoCreateBody(body, "application/json", "local-video", channel, path)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	_ = json.Unmarshal(encoded, &payload)
	if path != "/jobs/createTask" || payload["model"] != "kling-2.6/text-to-video" {
		t.Fatalf("video mapping order/double mapping failed: path=%s body=%s", path, encoded)
	}
}
