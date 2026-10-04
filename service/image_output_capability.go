package service

import (
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

// ResolveImageOutputCapability returns only formats with an explicit protocol
// and model contract. Unknown channels keep their existing automatic behavior.
func ResolveImageOutputCapability(channel model.ModelChannel, modelName string) (model.ImageOutputCapability, bool) {
	modelName = strings.ToLower(strings.TrimSpace(modelName))
	if modelName == "" {
		return model.ImageOutputCapability{}, false
	}

	protocol := strings.ToLower(strings.TrimSpace(channel.Protocol))
	switch {
	case isKIEAdminChannel(channel):
		if supportsKIEJpegOutput(modelName) {
			return imageOutputCapability(model.ImageOutputFormatJPEG), true
		}
	case protocol == ModelChannelProtocolAPIMart:
		normalizedModel := normalizeImageOutputModelName(modelName)
		switch {
		case isAPIMartOutputFormatModel(modelName):
			return imageOutputCapability(model.ImageOutputFormatJPEG), true
		case isAPIMartSeedreamOutputFormatModel(normalizedModel):
			return imageOutputCapability(model.ImageOutputFormatJPEG), true
		}
	case protocol == ModelChannelProtocolOpenAI && !isGrok2APIProtocolChannel(channel):
		if isOpenAIGPTImageModel(modelName) {
			return imageOutputCapability(model.ImageOutputFormatPNGTransparent, model.ImageOutputFormatJPEG), true
		}
	}
	return model.ImageOutputCapability{}, false
}

func imageOutputCapability(formats ...model.ImageOutputFormat) model.ImageOutputCapability {
	defaultFormat := model.ImageOutputFormatJPEG
	for _, format := range formats {
		if format == model.ImageOutputFormatPNGTransparent {
			defaultFormat = format
			break
		}
	}
	return model.ImageOutputCapability{Formats: formats, DefaultFormat: defaultFormat}
}

func normalizeImageOutputModelName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "_", "-")
	value = strings.ReplaceAll(value, ".", "-")
	value = strings.ReplaceAll(value, "/", "-")
	return value
}

func isOpenAIGPTImageModel(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	for _, family := range []string{"gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"} {
		if isImageModelFamilyOrSnapshot(value, family) {
			return true
		}
	}
	return false
}

func isAPIMartOutputFormatModel(modelName string) bool {
	modelName = normalizeImageOutputModelName(modelName)
	return strings.Contains(modelName, "gpt-image-1") ||
		strings.Contains(modelName, "gpt-image-2") && strings.Contains("-"+modelName+"-", "-official-")
}

func isAPIMartSeedreamOutputFormatModel(modelName string) bool {
	return strings.Contains(modelName, "seedream-5") && !strings.Contains(modelName, "seedream-5-0-pro")
}

func isImageModelFamilyOrSnapshot(value string, family string) bool {
	if value == family {
		return true
	}
	suffix, ok := strings.CutPrefix(value, family+"-")
	return ok && isDateSnapshot(suffix)
}

func isDateSnapshot(value string) bool {
	if len(value) != len("2000-01-01") {
		return false
	}
	_, err := time.Parse("2006-01-02", value)
	return err == nil
}

func supportsKIEJpegOutput(modelName string) bool {
	switch strings.TrimPrefix(modelName, "kie/") {
	case "nano-banana-2", "nano-banana-pro", "google/nano-banana", "google/nano-banana-edit",
		"qwen/text-to-image", "qwen/image-edit", "qwen/image-to-image", "qwen2/image-edit", "qwen2/text-to-image":
		return true
	default:
		return false
	}
}
