package service

import (
	"reflect"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

// 不变式：settings.private.channels 的数组顺序就是前端模型选择器的显示顺序。
// 后端只允许按传入顺序拼接，去重时保留首次出现的位置；任何排序/重排都会
// 让管理端「渠道 ↑↓ 排序」失效。改动这些函数前先看 AGENTS.md「渠道顺序」规则。
func TestEnabledChannelModelsKeepsChannelOrder(t *testing.T) {
	tests := []struct {
		name     string
		channels []model.ModelChannel
		want     []string
	}{
		{
			name: "按渠道顺序拼接，渠道内按 models 顺序",
			channels: []model.ModelChannel{
				{ID: "c1", Enabled: true, Models: []string{"m1", "m2"}},
				{ID: "c2", Enabled: true, Models: []string{"m3"}},
				{ID: "c3", Enabled: true, Models: []string{"m4"}},
			},
			want: []string{"m1", "m2", "m3", "m4"},
		},
		{
			name: "跨渠道重名去重时保留首次出现的位置",
			channels: []model.ModelChannel{
				{ID: "c1", Enabled: true, Models: []string{"shared", "only1"}},
				{ID: "c2", Enabled: true, Models: []string{"only2", "shared"}},
			},
			want: []string{"shared", "only1", "only2"},
		},
		{
			name: "跳过停用渠道但保持其余顺序",
			channels: []model.ModelChannel{
				{ID: "c1", Enabled: true, Models: []string{"m1"}},
				{ID: "c2", Enabled: false, Models: []string{"hidden"}},
				{ID: "c3", Enabled: true, Models: []string{"m2"}},
			},
			want: []string{"m1", "m2"},
		},
		{
			name: "渠道顺序反转后输出顺序同步反转（顺序即显示顺序）",
			channels: []model.ModelChannel{
				{ID: "c3", Enabled: true, Models: []string{"m3"}},
				{ID: "c1", Enabled: true, Models: []string{"m1"}},
			},
			want: []string{"m3", "m1"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := enabledChannelModels(test.channels)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("enabledChannelModels() = %v, want %v", got, test.want)
			}
		})
	}
}

// 公开渠道信息（前端 model-picker 的输入）同样必须保持传入顺序。
func TestPublicChannelInfosKeepsChannelOrder(t *testing.T) {
	channels := []model.ModelChannel{
		{ID: "banana", Name: "香蕉", Protocol: ModelChannelProtocolGemini, BaseURL: "https://example.invalid", APIKey: "k", Enabled: true, Models: []string{"g1", "g2"}},
		{ID: "official4k", Name: "官方4K", Protocol: ModelChannelProtocolOpenAI, BaseURL: "https://example.invalid", APIKey: "k", Enabled: true, Models: []string{"o1"}},
		{ID: "native4k", Name: "原生4K", Protocol: ModelChannelProtocolOpenAI, BaseURL: "https://example.invalid", APIKey: "k", Enabled: true, Models: []string{"n1"}},
	}
	infos := publicChannelInfos(channels)
	got := make([]string, 0, len(infos))
	for _, info := range infos {
		got = append(got, info.ID)
	}
	want := []string{"banana", "official4k", "native4k"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("publicChannelInfos() 顺序 = %v, want %v", got, want)
	}
}
