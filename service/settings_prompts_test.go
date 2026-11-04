package service

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestNormalizePublicSettingSystemPromptsIgnoreDeprecatedPrompt(t *testing.T) {
	defaults := DefaultSystemPrompts()
	tests := []struct {
		name      string
		prompts   model.SystemPromptSetting
		wantImage string
		wantText  string
	}{
		{name: "empty", wantImage: defaults.Image, wantText: defaults.Text},
		{
			name:      "whitespace",
			prompts:   model.SystemPromptSetting{Image: " \t", Text: "\n "},
			wantImage: defaults.Image,
			wantText:  defaults.Text,
		},
		{
			name:      "explicit image",
			prompts:   model.SystemPromptSetting{Image: "图片专用提示词"},
			wantImage: "图片专用提示词",
			wantText:  defaults.Text,
		},
		{
			name:      "explicit text",
			prompts:   model.SystemPromptSetting{Text: "文本专用提示词"},
			wantImage: defaults.Image,
			wantText:  "文本专用提示词",
		},
		{
			name:      "explicit image and text",
			prompts:   model.SystemPromptSetting{Image: "图片专用提示词", Text: "文本专用提示词"},
			wantImage: "图片专用提示词",
			wantText:  "文本专用提示词",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			setting := normalizePublicSetting(model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{
				SystemPrompt:  "废弃的通用提示词",
				SystemPrompts: test.prompts,
			}})
			got := setting.ModelChannel.SystemPrompts
			if got.Image != test.wantImage {
				t.Errorf("image system prompt = %q, want %q", got.Image, test.wantImage)
			}
			if got.Text != test.wantText {
				t.Errorf("text system prompt = %q, want %q", got.Text, test.wantText)
			}
		})
	}
}
