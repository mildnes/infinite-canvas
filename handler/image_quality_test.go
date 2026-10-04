package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/textproto"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func testImageQualityChannel() model.ModelChannel {
	return model.ModelChannel{
		ImageQualityCapabilities: map[string]model.ImageQualityCapability{
			"render-model": {
				Values:       []string{"low", "medium", "high", "auto"},
				Map:          map[string]string{"xhigh": "high", "max": "high"},
				DefaultValue: "high",
			},
			"no-quality": {},
		},
	}
}

func TestNormalizeImageQualityRequestMapsDeclaredValue(t *testing.T) {
	body := []byte(`{"model":"render-model","prompt":"scene","quality":"max"}`)
	encoded, contentType, result, err := normalizeImageQualityRequest(body, "application/json", testImageQualityChannel(), "render-model", "/images/generations")
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "application/json" || result.Quality != "high" || result.Notice == "" {
		t.Fatalf("content type/result = %q/%#v", contentType, result)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["quality"] != "high" {
		t.Fatalf("quality = %#v, want high", payload["quality"])
	}
}

func TestNormalizeImageQualityRequestLeavesUndeclaredValueUntouched(t *testing.T) {
	body := []byte(`{"model":"other-model","prompt":"scene","quality":"max"}`)
	encoded, _, result, err := normalizeImageQualityRequest(body, "application/json", testImageQualityChannel(), "other-model", "/images/generations")
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != string(body) || result != (imageQualityResult{}) {
		t.Fatalf("encoded/result = %s/%#v, want unchanged", encoded, result)
	}
}

func TestNormalizeImageQualityRequestRemovesQualityForExplicitlyUnsupportedModel(t *testing.T) {
	body := []byte(`{"model":"no-quality","prompt":"scene","quality":"max"}`)
	encoded, _, result, err := normalizeImageQualityRequest(body, "application/json", testImageQualityChannel(), "no-quality", "/images/generations")
	if err != nil {
		t.Fatal(err)
	}
	if result.Notice == "" || result.Quality != "" {
		t.Fatalf("result = %#v, want observable removal", result)
	}
	if strings.Contains(string(encoded), `"quality"`) {
		t.Fatalf("quality should be removed: %s", encoded)
	}
}

func TestNormalizeImageQualityRequestMultipart(t *testing.T) {
	var source bytes.Buffer
	writer := multipart.NewWriter(&source)
	_ = writer.WriteField("model", "render-model")
	_ = writer.WriteField("quality", "xhigh")
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="image"; filename="source.png"`)
	header.Set("Content-Type", "image/png")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("png"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	encoded, contentType, result, err := normalizeImageQualityRequest(source.Bytes(), writer.FormDataContentType(), testImageQualityChannel(), "render-model", "/images/edits")
	if err != nil {
		t.Fatal(err)
	}
	if result.Quality != "high" || result.Notice == "" || !strings.HasPrefix(contentType, "multipart/form-data;") {
		t.Fatalf("content type/result = %q/%#v", contentType, result)
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
	if values := form.Value["quality"]; len(values) != 1 || values[0] != "high" {
		t.Fatalf("quality = %#v, want high", values)
	}
	files := form.File["image"]
	if len(files) != 1 || files[0].Filename != "source.png" || files[0].Header.Get("Content-Type") != "image/png" {
		t.Fatalf("image metadata changed: %#v", files)
	}
	file, err := files[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil || string(data) != "png" {
		t.Fatalf("image bytes changed: %q, %v", data, err)
	}
}

func TestNormalizeImageQualityRequestResponsesTool(t *testing.T) {
	body := []byte(`{"model":"render-model","tools":[{"type":"image_generation","quality":"max"}]}`)
	encoded, _, result, err := normalizeImageQualityRequest(body, "application/json", testImageQualityChannel(), "render-model", "/responses")
	if err != nil {
		t.Fatal(err)
	}
	if result.Quality != "high" || result.Notice == "" || !strings.Contains(string(encoded), `"quality":"high"`) {
		t.Fatalf("encoded/result = %s/%#v", encoded, result)
	}
}

func TestNormalizeImageQualityDoesNotInjectParametersOrRewriteText(t *testing.T) {
	for _, test := range []struct{ endpoint, body string }{
		{"/images/generations", `{"model":"render-model","prompt":"scene"}`},
		{"/chat/completions", `{"model":"render-model","quality":"max","messages":[]}`},
		{"/responses", `{"model":"render-model","quality":"max","tools":[{"type":"function","name":"lookup"}]}`},
		{"/videos", `{"model":"render-model","quality":"max"}`},
	} {
		encoded, _, result, err := normalizeImageQualityRequest([]byte(test.body), "application/json", testImageQualityChannel(), "render-model", test.endpoint)
		if err != nil || string(encoded) != test.body || result != (imageQualityResult{}) {
			t.Fatalf("endpoint %s changed a non-image or missing-quality request: %s, %#v, %v", test.endpoint, encoded, result, err)
		}
	}
}

func TestNormalizeImageQualityChatAndDefaultFallback(t *testing.T) {
	body := []byte(`{"model":"render-model","modalities":["image"],"image_config":{"quality":"unsupported"}}`)
	encoded, _, result, err := normalizeImageQualityRequest(body, "application/json", testImageQualityChannel(), "render-model", "/chat/completions")
	if err != nil || result.Quality != "high" || result.Notice == "" || !strings.Contains(string(encoded), `"quality":"high"`) {
		t.Fatalf("Chat image quality fallback = %s, %#v, %v", encoded, result, err)
	}
	accepted := []byte(`{"quality":"high","prompt":"scene"}`)
	encoded, _, result, err = normalizeImageQualityRequest(accepted, "application/json", testImageQualityChannel(), "render-model", "/images/generations")
	if err != nil || string(encoded) != string(accepted) || result.Quality != "high" || result.Notice != "" {
		t.Fatalf("accepted quality changed: %s, %#v, %v", encoded, result, err)
	}
}
