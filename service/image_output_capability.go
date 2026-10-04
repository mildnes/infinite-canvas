package service

import (
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/shared"
)

// ResolveDeclaredImageOutputCapability returns a channel's explicit per-model
// output contract, including declarations that explicitly allow no formats.
func ResolveDeclaredImageOutputCapability(channel model.ModelChannel, modelName string) (model.ImageOutputCapability, bool) {
	modelName = strings.TrimSpace(modelName)
	if modelName == "" {
		return model.ImageOutputCapability{}, false
	}

	capabilities := normalizeImageOutputCapabilities(channel.ImageOutputCapabilities)
	capability, ok := capabilities[modelName]
	return capability, ok
}

// ResolveImageOutputCapability prefers a channel declaration and uses the
// shared protocol rules only when that model has no declaration.
func ResolveImageOutputCapability(channel model.ModelChannel, modelName string) (model.ImageOutputCapability, bool) {
	if capability, ok := ResolveDeclaredImageOutputCapability(channel, modelName); ok {
		return capability, true
	}

	formats, defaultFormat, ok := shared.MatchImageOutputCapabilityRule(channel.Protocol, channel.BaseURL, channel.Name, modelName)
	if !ok {
		return model.ImageOutputCapability{}, false
	}

	capability := model.ImageOutputCapability{DefaultFormat: model.ImageOutputFormat(defaultFormat)}
	for _, format := range formats {
		capability.Formats = append(capability.Formats, model.ImageOutputFormat(format))
	}
	modelName = strings.TrimSpace(modelName)
	normalized := normalizeImageOutputCapabilities(map[string]model.ImageOutputCapability{modelName: capability}, []string{modelName})
	return normalized[modelName], true
}
