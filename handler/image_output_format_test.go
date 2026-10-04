package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/textproto"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestNormalizeImageOutputFormatRequestByChannel(t *testing.T) {
	tests := []struct {
		name       string
		channel    model.ModelChannel
		model      string
		format     string
		wantFormat string
		wantBG     string
		wantNotice bool
	}{
		{name: "OpenAI transparent PNG", channel: model.ModelChannel{Protocol: "openai"}, model: "gpt-image-2", format: "png", wantFormat: "png", wantBG: "transparent"},
		{name: "OpenAI JPEG", channel: model.ModelChannel{Protocol: "openai"}, model: "gpt-image-1", format: "jpeg", wantFormat: "jpeg"},
		{name: "APIMart official PNG", channel: model.ModelChannel{Protocol: "apimart"}, model: "gpt-image-2-official", format: "png", wantFormat: "png", wantBG: "transparent"},
		{name: "APIMart ext PNG falls back to automatic", channel: model.ModelChannel{Protocol: "apimart"}, model: "gpt-image-2-ext", format: "png", wantNotice: true},
		{name: "APIMart unknown PNG falls back to automatic", channel: model.ModelChannel{Protocol: "apimart"}, model: "gpt-image-2.5-unknown", format: "png", wantNotice: true},
		{name: "unknown model strips new fields", channel: model.ModelChannel{Protocol: "openai"}, model: "gpt-4o", format: "png", wantNotice: true},
		{name: "xAI strips new fields", channel: model.ModelChannel{Protocol: "xai"}, model: "gpt-image-2", format: "png", wantNotice: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := []byte(`{"model":"` + test.model + `","prompt":"scene","output_format":"` + test.format + `","background":"transparent"}`)
			encoded, contentType, result, err := normalizeImageOutputFormatRequest(body, "application/json", test.channel, test.model, "/images/generations")
			if err != nil {
				t.Fatal(err)
			}
			if contentType != "application/json" {
				t.Fatalf("content type = %q", contentType)
			}
			var payload map[string]any
			if err := json.Unmarshal(encoded, &payload); err != nil {
				t.Fatal(err)
			}
			if got := payload["output_format"]; got != nil && got != test.wantFormat {
				t.Fatalf("output_format = %#v, want %#v", got, test.wantFormat)
			}
			if test.wantFormat != "" && payload["output_format"] != test.wantFormat {
				t.Fatalf("output_format = %#v, want %q", payload["output_format"], test.wantFormat)
			}
			if got := payload["background"]; got != nil && got != test.wantBG {
				t.Fatalf("background = %#v, want %#v", got, test.wantBG)
			}
			if (result.Notice != "") != test.wantNotice {
				t.Fatalf("notice = %q, want notice=%v", result.Notice, test.wantNotice)
			}
			if test.wantFormat == "" {
				if _, ok := payload["output_format"]; ok {
					t.Fatalf("unsupported format was retained: %#v", payload)
				}
				if _, ok := payload["background"]; ok {
					t.Fatalf("unsupported background was retained: %#v", payload)
				}
			}
		})
	}
}

func TestNormalizeImageOutputFormatPreservesLegacyPNGAndWebP(t *testing.T) {
	channel := model.ModelChannel{Protocol: "openai"}
	for _, format := range []string{"png", "webp"} {
		t.Run(format, func(t *testing.T) {
			body := []byte(`{"model":"gpt-image-2","prompt":"scene","output_format":"` + format + `"}`)
			encoded, contentType, result, err := normalizeImageOutputFormatRequest(body, "application/json", channel, "gpt-image-2", "/images/generations")
			if err != nil || !bytes.Equal(encoded, body) {
				t.Fatalf("legacy output format changed: body=%s err=%v", encoded, err)
			}
			if contentType != "application/json" || result != (imageOutputFormatResult{}) {
				t.Fatalf("contentType=%q result=%#v", contentType, result)
			}
		})
	}

	body := []byte(`{"model":"gpt-image-2","prompt":"scene","background":"transparent"}`)
	encoded, _, result, err := normalizeImageOutputFormatRequest(body, "application/json", channel, "gpt-image-2", "/images/generations")
	if err != nil || !bytes.Equal(encoded, body) || result != (imageOutputFormatResult{}) {
		t.Fatalf("background without output_format changed: body=%s result=%#v err=%v", encoded, result, err)
	}
}

func TestNormalizeImageOutputFormatMultipartPreservesImageFile(t *testing.T) {
	var source bytes.Buffer
	writer := multipart.NewWriter(&source)
	if err := writer.WriteField("model", "gpt-image-2"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("prompt", "scene"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("output_format", "png"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("background", "transparent"); err != nil {
		t.Fatal(err)
	}
	file, err := writer.CreatePart(textproto.MIMEHeader{
		"Content-Disposition": {`form-data; name="image"; filename="reference.png"`},
		"Content-Type":        {"image/png"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("png-bytes")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	channel := model.ModelChannel{Protocol: "openai"}
	encoded, contentType, result, err := normalizeImageOutputFormatRequest(source.Bytes(), writer.FormDataContentType(), channel, "gpt-image-2", "/images/edits")
	if err != nil {
		t.Fatal(err)
	}
	if result.Format != string(model.ImageOutputFormatPNGTransparent) {
		t.Fatalf("effective format = %q", result.Format)
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatal(err)
	}
	form, err := multipart.NewReader(bytes.NewReader(encoded), params["boundary"]).ReadForm(1 << 20)
	if err != nil {
		t.Fatal(err)
	}
	defer form.RemoveAll()
	if form.Value["output_format"][0] != "png" || form.Value["background"][0] != "transparent" {
		t.Fatalf("output fields = %#v", form.Value)
	}
	input, err := form.File["image"][0].Open()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	imageBytes, err := io.ReadAll(input)
	if err != nil || string(imageBytes) != "png-bytes" {
		t.Fatalf("image bytes = %q, err=%v", imageBytes, err)
	}
}

func TestNormalizeImageOutputFormatResponsesTool(t *testing.T) {
	body := []byte(`{"model":"gpt-image-2","tools":[{"type":"image_generation","output_format":"png","background":"transparent"}]}`)
	encoded, _, result, err := normalizeImageOutputFormatRequest(body, "application/json", model.ModelChannel{Protocol: "openai"}, "gpt-image-2", "/responses")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	tool := payload["tools"].([]any)[0].(map[string]any)
	if tool["output_format"] != "png" || tool["background"] != "transparent" || result.Format != string(model.ImageOutputFormatPNGTransparent) {
		t.Fatalf("tool=%#v result=%#v", tool, result)
	}
}

func TestNormalizeImageOutputFormatChatOnlyTouchesImagePayloads(t *testing.T) {
	channel := model.ModelChannel{Protocol: "openai"}
	textBody := []byte(`{"model":"gpt-image-2","messages":[],"output_format":"png","background":"transparent"}`)
	unchanged, _, _, err := normalizeImageOutputFormatRequest(textBody, "application/json", channel, "gpt-image-2", "/chat/completions")
	if err != nil || !bytes.Equal(unchanged, textBody) {
		t.Fatalf("ordinary chat changed: body=%s err=%v", unchanged, err)
	}

	imageBody := []byte(`{"model":"gpt-image-2","modalities":["image","text"],"image_config":{"output_format":"jpeg","background":"transparent"}}`)
	encoded, _, result, err := normalizeImageOutputFormatRequest(imageBody, "application/json", channel, "gpt-image-2", "/chat/completions")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	config := payload["image_config"].(map[string]any)
	if config["output_format"] != "jpeg" || config["background"] != nil || result.Format != string(model.ImageOutputFormatJPEG) {
		t.Fatalf("image_config=%#v result=%#v", config, result)
	}
}

func TestNormalizeImageOutputFormatResponsesWithoutImageToolUnchanged(t *testing.T) {
	body := []byte(`{"model":"gpt-image-2","input":"plain text","output_format":"png"}`)
	encoded, _, _, err := normalizeImageOutputFormatRequest(body, "application/json", model.ModelChannel{Protocol: "openai"}, "gpt-image-2", "/responses")
	if err != nil || !bytes.Equal(encoded, body) {
		t.Fatalf("non-image Responses body changed: body=%s err=%v", encoded, err)
	}
}

func TestAPIMartImageOutputFormatUsesDocumentedModels(t *testing.T) {
	channel := model.ModelChannel{Protocol: "apimart"}
	for _, modelName := range []string{
		"gpt-image-1-official", "gpt-image-1.5-official", "gpt-image-2-official",
		"gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
	} {
		t.Run(modelName, func(t *testing.T) {
			request := []byte(`{"model":"` + modelName + `","prompt":"scene","output_format":"png","background":"transparent"}`)
			body, contentType, _, err := normalizeImageOutputFormatRequest(request, "application/json", channel, modelName, "/images/generations")
			if err != nil {
				t.Fatal(err)
			}
			encoded, contentType, err := normalizeAPIMartImageBody(body, contentType, modelName, channel)
			if err != nil {
				t.Fatal(err)
			}
			if contentType != "application/json" {
				t.Fatalf("content type = %q", contentType)
			}
			var payload map[string]any
			if err := json.Unmarshal(encoded, &payload); err != nil {
				t.Fatal(err)
			}
			if payload["output_format"] != "png" || payload["background"] != "transparent" {
				t.Fatalf("APIMart payload=%#v", payload)
			}
		})
	}
}

func TestAPIMartImageOutputFormatDefaultsDoNotAddParameters(t *testing.T) {
	channel := model.ModelChannel{Protocol: "apimart"}
	modelName := "gpt-image-2-official"
	body := []byte(`{"model":"` + modelName + `","prompt":"scene"}`)
	encoded, contentType, _, err := normalizeImageOutputFormatRequest(body, "application/json", channel, modelName, "/images/generations")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _, err = normalizeAPIMartImageBody(encoded, contentType, modelName, channel)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	if _, ok := payload["output_format"]; ok {
		t.Fatalf("default APIMart request got output_format: %#v", payload)
	}
	if _, ok := payload["background"]; ok {
		t.Fatalf("default APIMart request got background: %#v", payload)
	}
}

func TestAPIMartImageOutputFormatJPEGRemovesTransparentBackground(t *testing.T) {
	channel := model.ModelChannel{Protocol: "apimart"}
	modelName := "gpt-image-2-official"
	body, contentType, _, err := normalizeImageOutputFormatRequest([]byte(`{"model":"`+modelName+`","prompt":"scene","output_format":"jpeg","background":"transparent"}`), "application/json", channel, modelName, "/images/generations")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _, err := normalizeAPIMartImageBody(body, contentType, modelName, channel)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["output_format"] != "jpeg" {
		t.Fatalf("output_format = %#v, want jpeg", payload["output_format"])
	}
	if _, ok := payload["background"]; ok {
		t.Fatalf("JPEG retained transparent background: %#v", payload)
	}
}

func TestAPIMartImageOutputFormatMultipartEditPreservesMultipleImages(t *testing.T) {
	var source bytes.Buffer
	writer := multipart.NewWriter(&source)
	for key, value := range map[string]string{
		"model":         "gpt-image-2.5-flare",
		"prompt":        "combine references",
		"output_format": "png",
		"background":    "transparent",
	} {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	for _, imageURL := range []string{"https://example.com/one.png", "https://example.com/two.png"} {
		if err := writer.WriteField("image_urls", imageURL); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	channel := model.ModelChannel{Protocol: "apimart"}
	modelName := "gpt-image-2.5-flare"
	body, contentType, result, err := normalizeImageOutputFormatRequest(source.Bytes(), writer.FormDataContentType(), channel, modelName, "/images/edits")
	if err != nil {
		t.Fatal(err)
	}
	if result.Format != string(model.ImageOutputFormatPNGTransparent) {
		t.Fatalf("effective format = %q", result.Format)
	}
	encoded, contentType, err := normalizeAPIMartImageBody(body, contentType, modelName, channel)
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "application/json" {
		t.Fatalf("content type = %q", contentType)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	refs, ok := payload["image_urls"].([]any)
	if !ok || len(refs) != 2 || refs[0] != "https://example.com/one.png" || refs[1] != "https://example.com/two.png" {
		t.Fatalf("image_urls = %#v", payload["image_urls"])
	}
	if payload["output_format"] != "png" || payload["background"] != "transparent" {
		t.Fatalf("output parameters = %#v", payload)
	}
}

func TestAPIMartImageOutputFormatMultipartEditPreservesImageFiles(t *testing.T) {
	var source bytes.Buffer
	writer := multipart.NewWriter(&source)
	for key, value := range map[string]string{
		"model":         "gpt-image-2.5-flare",
		"prompt":        "combine references",
		"output_format": "png",
		"background":    "transparent",
	} {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	for _, item := range []struct{ name, filename, content string }{
		{"image[]", "one.png", "one-bytes"},
		{"image[]", "two.png", "two-bytes"},
	} {
		part, err := writer.CreatePart(textproto.MIMEHeader{
			"Content-Disposition": {`form-data; name="` + item.name + `"; filename="` + item.filename + `"`},
			"Content-Type":        {"image/png"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte(item.content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	encoded, contentType, result, err := normalizeImageOutputFormatRequest(source.Bytes(), writer.FormDataContentType(), model.ModelChannel{Protocol: "apimart"}, "gpt-image-2.5-flare", "/images/edits")
	if err != nil {
		t.Fatal(err)
	}
	if result.Format != string(model.ImageOutputFormatPNGTransparent) {
		t.Fatalf("effective format = %q", result.Format)
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatal(err)
	}
	form, err := multipart.NewReader(bytes.NewReader(encoded), params["boundary"]).ReadForm(1 << 20)
	if err != nil {
		t.Fatal(err)
	}
	defer form.RemoveAll()
	if form.Value["output_format"][0] != "png" || form.Value["background"][0] != "transparent" {
		t.Fatalf("output fields = %#v", form.Value)
	}
	if len(form.File["image[]"]) != 2 {
		t.Fatalf("image files = %d, want 2", len(form.File["image[]"]))
	}
	for index, want := range []string{"one-bytes", "two-bytes"} {
		file, err := form.File["image[]"][index].Open()
		if err != nil {
			t.Fatal(err)
		}
		data, readErr := io.ReadAll(file)
		_ = file.Close()
		if readErr != nil || string(data) != want {
			t.Fatalf("image %d bytes = %q, err=%v", index, data, readErr)
		}
	}
}

func TestKIEImageOutputFormatUsesKIEProtocolField(t *testing.T) {
	channel := model.ModelChannel{Protocol: "kie", BaseURL: "https://api.kie.ai"}
	body, contentType, result, err := normalizeImageOutputFormatRequest([]byte(`{"model":"qwen/text-to-image","prompt":"scene","output_format":"jpeg"}`), "application/json", channel, "qwen/text-to-image", "/images/generations")
	if err != nil {
		t.Fatal(err)
	}
	prepared, provider, err := prepareAIProtocolRequest(aiProtocolRequest{
		mode: aiProtocolProxyRequest, body: body, contentType: contentType, modelName: "qwen/text-to-image",
		channel: channel, endpoint: "/images/generations", path: "/jobs/createTask",
	})
	if err != nil || provider != "kie" {
		t.Fatalf("provider=%q err=%v", provider, err)
	}
	var payload map[string]any
	if err := json.Unmarshal(prepared.body, &payload); err != nil {
		t.Fatal(err)
	}
	input := payload["input"].(map[string]any)
	if input["output_format"] != "jpg" || result.Format != string(model.ImageOutputFormatJPEG) {
		t.Fatalf("KIE input=%#v result=%#v", input, result)
	}
}

func TestAppendImageOutputLogMetadata(t *testing.T) {
	got := appendImageOutputLogMetadata(`{"model":"gpt-image-2"}`, "jpeg", "fell back")
	var payload map[string]any
	if err := json.Unmarshal([]byte(got), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["_image_output_format"] != "jpeg" || payload["_image_output_notice"] != "fell back" {
		t.Fatalf("metadata = %#v", payload)
	}
}
