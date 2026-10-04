package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/textproto"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

type imageQualityResult struct {
	Quality string
	Notice  string
}

func normalizeImageQualityRequest(body []byte, contentType string, channel model.ModelChannel, modelName string, endpoint string) ([]byte, string, imageQualityResult, error) {
	if !isImageQualityEndpoint(endpoint) {
		return body, contentType, imageQualityResult{}, nil
	}
	capability, supported := service.ResolveImageQualityCapability(channel, modelName)
	if !supported {
		return body, contentType, imageQualityResult{}, nil
	}
	if (endpoint == "/images/generations" || endpoint == "/images/edits") && strings.HasPrefix(strings.ToLower(contentType), "multipart/form-data") {
		return normalizeMultipartImageQuality(body, contentType, capability)
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body, contentType, imageQualityResult{}, nil
	}
	targets := imageQualityTargets(payload, endpoint)
	if len(targets) == 0 {
		return body, contentType, imageQualityResult{}, nil
	}
	result := imageQualityResult{}
	changed := false
	for _, target := range targets {
		requested, ok := target["quality"].(string)
		if !ok || strings.TrimSpace(requested) == "" {
			continue
		}
		normalized, fallback := resolveImageQuality(requested, capability)
		if normalized != requested {
			changed = true
			if normalized == "" {
				delete(target, "quality")
			} else {
				target["quality"] = normalized
			}
		}
		result.Quality = normalized
		if fallback {
			result.Notice = imageQualityFallbackNotice(requested, normalized)
		}
	}
	if result.Quality == "" && result.Notice == "" {
		return body, contentType, imageQualityResult{}, nil
	}
	if !changed {
		return body, contentType, result, nil
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return body, contentType, imageQualityResult{}, err
	}
	return encoded, "application/json", result, nil
}

func isImageQualityEndpoint(endpoint string) bool {
	switch endpoint {
	case "/images/generations", "/images/edits", "/responses", "/chat/completions":
		return true
	default:
		return false
	}
}

func imageQualityTargets(payload map[string]any, endpoint string) []map[string]any {
	if endpoint == "/images/generations" || endpoint == "/images/edits" {
		return []map[string]any{payload}
	}
	if endpoint == "/responses" {
		return imageGenerationToolTargets(payload["tools"])
	}
	if endpoint != "/chat/completions" {
		return nil
	}

	targets := imageGenerationToolTargets(payload["tools"])
	if hasImageModality(payload["modalities"]) || hasImageConfig(payload["image_config"]) {
		if _, ok := payload["quality"]; ok {
			targets = append(targets, payload)
		}
		if config, ok := payload["image_config"].(map[string]any); ok {
			if _, ok := config["quality"]; ok {
				targets = append(targets, config)
			}
		}
	}
	return targets
}

func resolveImageQuality(requested string, capability model.ImageQualityCapability) (string, bool) {
	for _, value := range capability.Values {
		if requested == value {
			return requested, false
		}
	}

	if mapped := qualityMapValue(capability.Map, requested); mapped != "" {
		if value, ok := declaredImageQualityValue(capability.Values, mapped); ok {
			return value, true
		}
	}
	if value, ok := declaredImageQualityValue(capability.Values, capability.DefaultValue); ok {
		return value, true
	}
	return "", true
}

func qualityMapValue(mapping map[string]string, requested string) string {
	if value := strings.TrimSpace(mapping[requested]); value != "" {
		return value
	}
	for key, value := range mapping {
		if strings.EqualFold(strings.TrimSpace(key), strings.TrimSpace(requested)) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func declaredImageQualityValue(values []string, requested string) (string, bool) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return "", false
	}
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), requested) {
			return value, true
		}
	}
	return "", false
}

func imageQualityFallbackNotice(requested string, actual string) string {
	if actual == "" {
		return fmt.Sprintf("当前模型不支持图片质量 %q，已移除该参数并使用供应商默认值。", requested)
	}
	return fmt.Sprintf("当前模型不支持图片质量 %q，已回退到 %q。", requested, actual)
}

func normalizeMultipartImageQuality(body []byte, contentType string, capability model.ImageQualityCapability) ([]byte, string, imageQualityResult, error) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return body, contentType, imageQualityResult{}, err
	}
	form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
	if err != nil {
		return body, contentType, imageQualityResult{}, err
	}
	defer form.RemoveAll()
	values := form.Value["quality"]
	if len(values) == 0 || strings.TrimSpace(values[0]) == "" {
		return body, contentType, imageQualityResult{}, nil
	}
	requested := values[0]
	actual, fallback := resolveImageQuality(requested, capability)
	result := imageQualityResult{Quality: actual}
	if fallback {
		result.Notice = imageQualityFallbackNotice(requested, actual)
	}
	if actual == requested {
		return body, contentType, result, nil
	}
	if actual == "" {
		delete(form.Value, "quality")
	} else {
		form.Value["quality"] = []string{actual}
	}

	var output bytes.Buffer
	writer := multipart.NewWriter(&output)
	for key, fieldValues := range form.Value {
		for _, value := range fieldValues {
			if err := writer.WriteField(key, value); err != nil {
				return body, contentType, imageQualityResult{}, err
			}
		}
	}
	for _, headers := range form.File {
		for _, header := range headers {
			file, err := header.Open()
			if err != nil {
				return body, contentType, imageQualityResult{}, err
			}
			part, err := writer.CreatePart(textproto.MIMEHeader(header.Header))
			if err == nil {
				_, err = io.Copy(part, file)
			}
			_ = file.Close()
			if err != nil {
				return body, contentType, imageQualityResult{}, err
			}
		}
	}
	if err := writer.Close(); err != nil {
		return body, contentType, imageQualityResult{}, err
	}
	return output.Bytes(), writer.FormDataContentType(), result, nil
}
