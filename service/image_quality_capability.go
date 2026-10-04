package service

import (
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

// ResolveImageQualityCapability returns a channel's explicit per-model quality
// contract. Channels without a declared contract keep their existing passthrough
// behavior.
func ResolveImageQualityCapability(channel model.ModelChannel, modelName string) (model.ImageQualityCapability, bool) {
	modelName = strings.TrimSpace(modelName)
	if modelName == "" {
		return model.ImageQualityCapability{}, false
	}

	capabilities := normalizeImageQualityCapabilities(channel.ImageQualityCapabilities)
	capability, ok := capabilities[modelName]
	if !ok {
		return model.ImageQualityCapability{}, false
	}
	return capability, true
}
