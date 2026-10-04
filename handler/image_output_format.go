package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/textproto"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

type imageOutputFormatResult struct {
	Format     string
	Notice     string
	NoticeCode string
}

func normalizeImageOutputFormatRequest(body []byte, contentType string, channel model.ModelChannel, modelName string, endpoint string) ([]byte, string, imageOutputFormatResult, error) {
	imageEndpoint := endpoint == "/images/generations" || endpoint == "/images/edits"
	if !imageEndpoint && endpoint != "/responses" && endpoint != "/chat/completions" {
		return body, contentType, imageOutputFormatResult{}, nil
	}

	capability, supported := service.ResolveImageOutputCapability(channel, modelName)
	if isGrok2APIMediaAdapterChannel(channel, modelName) {
		supported = false
	}
	if imageEndpoint && strings.HasPrefix(strings.ToLower(contentType), "multipart/form-data") {
		return normalizeMultipartImageOutputFormat(body, contentType, capability, supported, channel)
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body, contentType, imageOutputFormatResult{}, nil
	}
	targets := imageOutputFormatTargets(payload, endpoint)
	if len(targets) == 0 {
		return body, contentType, imageOutputFormatResult{}, nil
	}
	var result imageOutputFormatResult
	if !supported {
		result = undeclaredImageOutputFormat()
	}
	changed := false
	for _, target := range targets {
		requested, hasSelection := readRequestedImageOutputFormat(toStringSafe(target["output_format"]), toStringSafe(target["background"]))
		if !hasSelection {
			continue
		}
		result = resolveImageOutputFormat(requested, capability, supported)
		applyImageOutputFormat(target, result.Format, channel)
		changed = true
	}
	if !changed {
		return body, contentType, result, nil
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return body, contentType, imageOutputFormatResult{}, err
	}
	return encoded, "application/json", result, nil
}

func imageOutputFormatTargets(payload map[string]any, endpoint string) []map[string]any {
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
		if _, hasSelection := readRequestedImageOutputFormat(toStringSafe(payload["output_format"]), toStringSafe(payload["background"])); hasSelection {
			targets = append(targets, payload)
		} else if imageConfig, ok := payload["image_config"].(map[string]any); ok {
			targets = append(targets, imageConfig)
		} else {
			targets = append(targets, payload)
		}
	}
	return targets
}

func imageGenerationToolTargets(value any) []map[string]any {
	tools, ok := value.([]any)
	if !ok {
		return nil
	}
	targets := make([]map[string]any, 0, len(tools))
	for _, item := range tools {
		tool, ok := item.(map[string]any)
		if ok && strings.EqualFold(strings.TrimSpace(toStringSafe(tool["type"])), "image_generation") {
			targets = append(targets, tool)
		}
	}
	return targets
}

func hasImageModality(value any) bool {
	modalities, ok := value.([]any)
	if !ok {
		return false
	}
	for _, modality := range modalities {
		if strings.EqualFold(strings.TrimSpace(toStringSafe(modality)), "image") {
			return true
		}
	}
	return false
}

func hasImageConfig(value any) bool {
	config, ok := value.(map[string]any)
	return ok && config != nil
}

func normalizeMultipartImageOutputFormat(body []byte, contentType string, capability model.ImageOutputCapability, supported bool, channel model.ModelChannel) ([]byte, string, imageOutputFormatResult, error) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return body, contentType, imageOutputFormatResult{}, err
	}
	form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
	if err != nil {
		return body, contentType, imageOutputFormatResult{}, err
	}
	defer form.RemoveAll()
	formats := form.Value["output_format"]
	backgrounds := form.Value["background"]
	formatValue, backgroundValue := "", ""
	if len(formats) > 0 {
		formatValue = formats[0]
	}
	if len(backgrounds) > 0 {
		backgroundValue = backgrounds[0]
	}
	requested, hasSelection := readRequestedImageOutputFormat(formatValue, backgroundValue)
	if !hasSelection {
		if !supported {
			return body, contentType, undeclaredImageOutputFormat(), nil
		}
		return body, contentType, imageOutputFormatResult{}, nil
	}
	result := resolveImageOutputFormat(requested, capability, supported)
	format, background := imageOutputWireValues(result.Format, channel)
	if format == "" {
		delete(form.Value, "output_format")
	} else {
		form.Value["output_format"] = []string{format}
	}
	if background == "" {
		delete(form.Value, "background")
	} else {
		form.Value["background"] = []string{background}
	}

	var output bytes.Buffer
	writer := multipart.NewWriter(&output)
	for key, values := range form.Value {
		for _, value := range values {
			if err := writer.WriteField(key, value); err != nil {
				return body, contentType, imageOutputFormatResult{}, err
			}
		}
	}
	for _, headers := range form.File {
		for _, header := range headers {
			file, err := header.Open()
			if err != nil {
				return body, contentType, imageOutputFormatResult{}, err
			}
			partHeader := textproto.MIMEHeader(header.Header)
			part, err := writer.CreatePart(partHeader)
			if err == nil {
				_, err = io.Copy(part, file)
			}
			_ = file.Close()
			if err != nil {
				return body, contentType, imageOutputFormatResult{}, err
			}
		}
	}
	if err := writer.Close(); err != nil {
		return body, contentType, imageOutputFormatResult{}, err
	}
	return output.Bytes(), writer.FormDataContentType(), result, nil
}

func readRequestedImageOutputFormat(format string, background string) (model.ImageOutputFormat, bool) {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "png-transparent":
		return model.ImageOutputFormatPNGTransparent, true
	case "png":
		if strings.EqualFold(strings.TrimSpace(background), "transparent") {
			return model.ImageOutputFormatPNGTransparent, true
		}
		return "", false
	case "jpg", "jpeg":
		return model.ImageOutputFormatJPEG, true
	default:
		return "", false
	}
}

func resolveImageOutputFormat(requested model.ImageOutputFormat, capability model.ImageOutputCapability, supported bool) imageOutputFormatResult {
	if !supported {
		return undeclaredImageOutputFormat()
	}
	for _, format := range capability.Formats {
		if format == requested {
			return imageOutputFormatResult{Format: string(requested)}
		}
	}
	defaultFormat := capability.DefaultFormat
	validDefault := false
	for _, format := range capability.Formats {
		validDefault = validDefault || format == defaultFormat
	}
	if !validDefault {
		return imageOutputFormatResult{Format: "auto", Notice: "当前模型不支持所选输出格式，已使用渠道默认格式。", NoticeCode: "fallback-default"}
	}
	return imageOutputFormatResult{
		Format:     string(defaultFormat),
		Notice:     "当前模型不支持所选输出格式，已切换到该渠道默认格式。",
		NoticeCode: "fallback-default",
	}
}

func undeclaredImageOutputFormat() imageOutputFormatResult {
	return imageOutputFormatResult{Format: "auto", Notice: "该模型未声明输出格式能力，保持自动输出。", NoticeCode: "undeclared"}
}

func applyImageOutputFormat(payload map[string]any, format string, channel model.ModelChannel) {
	wireFormat, background := imageOutputWireValues(format, channel)
	if wireFormat == "" {
		delete(payload, "output_format")
		delete(payload, "background")
		return
	}
	payload["output_format"] = wireFormat
	if background == "" {
		delete(payload, "background")
	} else {
		payload["background"] = background
	}
}

func imageOutputWireValues(format string, channel model.ModelChannel) (string, string) {
	switch model.ImageOutputFormat(format) {
	case model.ImageOutputFormatPNGTransparent:
		if isKIEChannel(channel, "") {
			return "png", ""
		}
		return "png", "transparent"
	case model.ImageOutputFormatJPEG:
		return "jpeg", ""
	default:
		return "", ""
	}
}
