package handler

import (
	"reflect"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestPrepareDirectAIRequestImageOutputDeclarations(t *testing.T) {
	for _, endpoint := range []string{"/images/generations", "/images/edits"} {
		for _, test := range []struct {
			name, modelName, wantFormat, wantNotice string
			capability                              *model.ImageOutputCapability
		}{
			{"custom declaration", "custom-renderer", "png", "", &model.ImageOutputCapability{Formats: []model.ImageOutputFormat{model.ImageOutputFormatPNGTransparent}}},
			{"bare GPT declaration", "gpt-image-2", "png", "", &model.ImageOutputCapability{Formats: []model.ImageOutputFormat{model.ImageOutputFormatPNGTransparent}}},
			{"disabled declaration", "gpt-image-2-official", "", "fallback-default", &model.ImageOutputCapability{Formats: []model.ImageOutputFormat{}}},
			{"undeclared alias", "custom-renderer", "", "undeclared", nil},
			{"shared version family", "gpt-image-9.1-sunburst", "png", "", nil},
		} {
			t.Run(endpoint+"/"+test.name, func(t *testing.T) {
				channel := directAIChannelInput{Protocol: "apimart", BaseURL: "https://api.apimart.ai", Models: []string{test.modelName}}
				if test.capability != nil {
					channel.ImageOutputCapabilities = map[string]model.ImageOutputCapability{test.modelName: *test.capability}
				}
				plan, err := prepareDirectAIRequest(directAIRequestInput{Channel: channel, Model: test.modelName, Endpoint: endpoint, Body: map[string]any{
					"prompt": "test", "output_format": "png", "background": "transparent", "quality": "HIGH",
				}})
				if err != nil {
					t.Fatal(err)
				}
				payload := testDirectRecord(t, plan.Body)
				if test.wantFormat == "" {
					if _, ok := payload["output_format"]; ok {
						t.Fatalf("unexpected output_format: %#v", payload)
					}
					if _, ok := payload["background"]; ok {
						t.Fatalf("unexpected background: %#v", payload)
					}
				} else if payload["output_format"] != test.wantFormat || payload["background"] != "transparent" || plan.ImageOutputFormat != "png-transparent" {
					t.Fatalf("declaration lost during translation: %#v", plan)
				}
				if plan.ImageOutputNoticeCode != test.wantNotice {
					t.Fatalf("notice: %#v", plan)
				}
				if test.modelName == "gpt-image-2" && payload["quality"] != "high" {
					t.Fatalf("quality normalization changed: %#v", payload)
				}
			})
		}
	}
}

func TestPrepareDirectAIRequestUndeclaredAutoKeepsBody(t *testing.T) {
	plan, err := prepareDirectAIRequest(directAIRequestInput{
		Channel: directAIChannelInput{Protocol: "apimart", BaseURL: "https://api.apimart.ai"}, Model: "custom-renderer", Endpoint: "/images/generations",
		Body: map[string]any{"prompt": "test", "size": "1:1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := testDirectRecord(t, plan.Body)
	if _, ok := payload["output_format"]; ok {
		t.Fatalf("auto injected output: %#v", payload)
	}
	if _, ok := payload["background"]; ok {
		t.Fatalf("auto injected background: %#v", payload)
	}
	if plan.ImageOutputNoticeCode != "undeclared" {
		t.Fatalf("notice: %#v", plan)
	}
}

func TestPrepareDirectAIRequestKIEReferences(t *testing.T) {
	markers := map[string]string{
		"image1": "https://direct-reference.invalid/run/image/0",
		"image2": "https://direct-reference.invalid/run/image/1",
		"video":  "https://direct-reference.invalid/run/video/2",
		"audio":  "https://direct-reference.invalid/run/audio/3",
	}
	plan, err := prepareDirectAIRequest(directAIRequestInput{
		Channel:  directAIChannelInput{Protocol: "kie", BaseURL: "https://api.kie.ai"},
		Model:    "bytedance/seedance-2",
		Endpoint: "/videos",
		Body: map[string]any{
			"prompt":            "test",
			"input_reference[]": []any{markers["image1"], markers["image2"]},
			"video_reference[]": []any{markers["video"]},
			"audio_reference[]": []any{markers["audio"]},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Provider != "kie" || !strings.HasSuffix(plan.URL, "/v1/jobs/createTask") {
		t.Fatalf("unexpected plan: %#v", plan)
	}
	input := testDirectRecord(t, testDirectRecord(t, plan.Body)["input"])
	testDirectStrings(t, input["reference_image_urls"], markers["image1"], markers["image2"])
	testDirectStrings(t, input["reference_video_urls"], markers["video"])
	testDirectStrings(t, input["reference_audio_urls"], markers["audio"])
	for _, kind := range []string{"image", "video", "audio"} {
		if _, ok := plan.Uploads[kind]; !ok {
			t.Fatalf("missing %s upload plan", kind)
		}
	}
}

func TestPrepareDirectAIRequestKIEGrokImagineImage20(t *testing.T) {
	plan, err := prepareDirectAIRequest(directAIRequestInput{
		Channel:  directAIChannelInput{Protocol: "kie", BaseURL: "https://api.kie.ai"},
		Model:    "grok-imagine-image-2-0/text-to-image",
		Endpoint: "/images/generations",
		Body:     map[string]any{"prompt": "test", "size": "1536x1024"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Provider != "kie" || !strings.HasSuffix(plan.URL, "/v1/client/tasks") {
		t.Fatalf("unexpected plan: %#v", plan)
	}
	payload := testDirectRecord(t, plan.Body)
	if payload["model"] != "grok-imagine-image-2-0/text-to-image" {
		t.Fatalf("unexpected model: %#v", payload["model"])
	}
	input := testDirectRecord(t, payload["input"])
	if input["prompt"] != "test" || input["aspect_ratio"] != "3:2" {
		t.Fatalf("unexpected input: %#v", input)
	}
}

func TestNormalizeKIEKlingOmniVideoInput(t *testing.T) {
	tests := []struct {
		name  string
		model string
		input map[string]any
		want  map[string]any
	}{
		{
			name: "text smart shots", model: "kling-3.0-omni/text-to-video",
			input: map[string]any{"prompt": "scene", "mode": "pro", "multi_shot": true, "shot_type": "intelligence", "multi_prompt": []any{map[string]any{"prompt": "shot", "duration": "5"}}, "image_urls": []any{"image"}, "video_urls": []any{"video"}, "negative_prompt": "bad"},
			want:  map[string]any{"prompt": "scene", "resolution": "1080p", "customize_multi_shots": false, "prefer_multi_shots": true},
		},
		{
			name: "image first and last frames", model: "kling-3.0-omni/image-to-video",
			input: map[string]any{"prompt": "scene", "mode": "4k", "aspect_ratio": "16:9", "image_urls": []any{"first", "last"}, "multi_shot": true, "shot_type": "customize", "multi_prompt": []any{map[string]any{"prompt": "shot", "duration": "20"}}},
			want:  map[string]any{"prompt": "scene", "resolution": "4k", "aspect_ratio": "auto", "image_urls": []any{"first", "last"}, "customize_multi_shots": true, "prefer_multi_shots": false, "multi_prompt": []map[string]any{{"prompt": "shot", "duration": 15}}},
		},
		{
			name: "reference video constraints", model: "kling-3.0-omni/reference-to-video",
			input: map[string]any{"prompt": "scene", "mode": "std", "aspect_ratio": "9:16", "duration": 10, "image_urls": []any{"image"}, "video_urls": []any{"video"}, "audio": true, "multi_shot": true, "shot_type": "customize", "prefer_multi_shots": true, "multi_prompt": []any{map[string]any{"prompt": "shot", "duration": "5"}}, "element_list": []any{map[string]any{"name": "role", "element_input_urls": []any{"element"}}}},
			want:  map[string]any{"prompt": "scene", "resolution": "720p", "aspect_ratio": "auto", "duration": 10, "image_urls": []any{"image"}, "video_urls": []any{"video"}, "audio": false, "customize_multi_shots": true, "multi_prompt": []map[string]any{{"prompt": "shot", "duration": 5}}, "elements": []map[string]any{{"name": "role", "description": "", "element_input_urls": []string{"element"}}}},
		},
		{
			name: "pure video transformation", model: "kling-3.0-omni/transformation",
			input: map[string]any{"prompt": "scene", "mode": "std", "aspect_ratio": "16:9", "duration": 10, "video_urls": []any{"video"}, "audio": true, "multi_shot": true, "shot_type": "customize", "multi_prompt": []any{}, "elements": []any{map[string]any{"name": "role", "element_input_urls": []any{"image"}}}},
			want:  map[string]any{"prompt": "scene", "resolution": "720p", "aspect_ratio": "auto", "video_urls": []any{"video"}, "audio": true},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			normalizeKIEKlingOmniVideoInput(test.input, test.model)
			if !reflect.DeepEqual(test.input, test.want) {
				t.Fatalf("unexpected input:\nwant: %#v\n got: %#v", test.want, test.input)
			}
		})
	}
}

func TestPrepareDirectAIRequestAPIMartImageReferences(t *testing.T) {
	markers := []any{
		"https://direct-reference.invalid/run/image/0",
		"https://direct-reference.invalid/run/image/1",
	}
	plan, err := prepareDirectAIRequest(directAIRequestInput{
		Channel:  directAIChannelInput{Protocol: "apimart", BaseURL: "https://api.apimart.ai"},
		Model:    "gpt-image-2-apimart",
		Endpoint: "/images/edits",
		Body: map[string]any{
			"prompt": "test",
			"image":  markers,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Provider != "apimart" || !strings.HasSuffix(plan.URL, "/v1/images/generations") {
		t.Fatalf("unexpected plan: %#v", plan)
	}
	payload := testDirectRecord(t, plan.Body)
	testDirectStrings(t, payload["image_urls"], markers[0].(string), markers[1].(string))
	if _, ok := plan.Uploads["image"]; !ok {
		t.Fatal("missing image upload plan")
	}
	if _, ok := plan.Uploads["video"]; ok {
		t.Fatal("unexpected video upload plan")
	}
}

func TestPrepareDirectAIRequestRejectsMediaData(t *testing.T) {
	_, err := prepareDirectAIRequest(directAIRequestInput{
		Channel:  directAIChannelInput{Protocol: "kie", BaseURL: "https://api.kie.ai"},
		Model:    "bytedance/seedance-2",
		Endpoint: "/videos",
		Body:     map[string]any{"image": "data:image/png;base64,AAAA"},
	})
	if err == nil || !strings.Contains(err.Error(), "参考文件不能传给参数转译接口") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func testDirectRecord(t *testing.T, value any) map[string]any {
	t.Helper()
	record, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("expected object, got %#v", value)
	}
	return record
}

func testDirectStrings(t *testing.T, value any, expected ...string) {
	t.Helper()
	items, ok := value.([]any)
	if !ok {
		t.Fatalf("expected array, got %#v", value)
	}
	if len(items) != len(expected) {
		t.Fatalf("expected %d items, got %#v", len(expected), items)
	}
	for index, item := range items {
		if item != expected[index] {
			t.Fatalf("unexpected item %d: %#v", index, item)
		}
	}
}
