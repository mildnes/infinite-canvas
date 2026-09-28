package service

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestFetchAdminChannelModelsParsesOpenAIModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"z-model"},{"id":"a-model"},{"id":""}]}`))
	}))
	defer server.Close()

	models, err := fetchAdminChannelModels(model.ModelChannel{
		BaseURL: server.URL,
		APIKey:  "test-key",
	})
	if err != nil {
		t.Fatalf("fetchAdminChannelModels returned error: %v", err)
	}
	if want := []string{"a-model", "z-model"}; !reflect.DeepEqual(models, want) {
		t.Fatalf("models = %#v, want %#v", models, want)
	}
}

func TestFetchAdminChannelModelsReportsArkPlanModelsUnsupported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/plan/v3/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	_, err := fetchAdminChannelModels(model.ModelChannel{
		Protocol: ModelChannelProtocolArk,
		BaseURL:  server.URL + "/api/plan/v3/contents/generations/tasks",
		APIKey:   "test-key",
	})
	if err == nil {
		t.Fatal("expected unsupported /models error")
	}
	if !strings.Contains(err.Error(), "Agent Plan 未提供 OpenAI /models") {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestBuildModelChannelURLNormalizesArkPlanTaskPath(t *testing.T) {
	got := BuildModelChannelURL(model.ModelChannel{Protocol: ModelChannelProtocolArk, BaseURL: "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks?debug=1"}, "/models")
	want := "https://ark.cn-beijing.volces.com/api/plan/v3/models"
	if got != want {
		t.Fatalf("BuildModelChannelURL = %q, want %q", got, want)
	}
}

func TestBuildModelChannelURLZhipuV4(t *testing.T) {
	tests := []struct {
		baseURL string
		path    string
		want    string
	}{
		{"https://open.bigmodel.cn/api/paas/v4", "/chat/completions", "https://open.bigmodel.cn/api/paas/v4/chat/completions"},
		{"https://open.bigmodel.cn/api/paas/v4/", "/models", "https://open.bigmodel.cn/api/paas/v4/models"},
		{"https://open.bigmodel.cn/api/paas/v4", "/images/generations", "https://open.bigmodel.cn/api/paas/v4/images/generations"},
		{"https://ark.cn-beijing.volces.com/api/plan/v3", "/chat/completions", "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions"},
		{"https://api.openai.com", "/chat/completions", "https://api.openai.com/v1/chat/completions"},
	}
	for _, tt := range tests {
		got := BuildModelChannelURL(model.ModelChannel{BaseURL: tt.baseURL}, tt.path)
		if got != tt.want {
			t.Fatalf("BuildModelChannelURL(%q, %q) = %q, want %q", tt.baseURL, tt.path, got, tt.want)
		}
	}
}

func TestModelCostsExpandLegacyAcrossChannelsAndKeepOverrides(t *testing.T) {
	settings := normalizeSettings(model.Settings{
		Private: model.PrivateSetting{Channels: []model.ModelChannel{
			{ID: "channel-a", Models: []string{"shared", "new"}, Enabled: true},
			{ID: "channel-b", Models: []string{"shared"}, Enabled: false},
		}},
		Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{ModelCosts: []model.ModelCost{
			{Model: "shared", Credits: 7},
			{ChannelID: "channel-b", Model: "shared", Credits: 18},
			{Model: "removed", Credits: 23},
		}}},
	})
	costs := settings.Public.ModelChannel.ModelCosts
	if got := modelCostForChannel(costs, "channel-a", "shared"); got != 7 {
		t.Fatalf("first channel price = %d, want 7", got)
	}
	if got := modelCostForChannel(costs, "channel-b", "shared"); got != 18 {
		t.Fatalf("second channel override = %d, want 18", got)
	}
	if got := modelCostForChannel(costs, "channel-a", "new"); got != 0 {
		t.Fatalf("unpriced model = %d, want 0", got)
	}
	if got := modelCostForChannel(costs, "", "shared"); got != 0 {
		t.Fatalf("missing channel must not inherit legacy price: %d", got)
	}
	if got := modelCostForChannel(costs, "channel-c", "removed"); got != 0 {
		t.Fatalf("unmatched legacy price must not bill a new channel: %d", got)
	}
	var orphanFound bool
	for _, cost := range costs {
		if cost.ChannelID == "" && cost.Model == "removed" && cost.Credits == 23 {
			orphanFound = true
		}
		if cost.ChannelID == "" && cost.Model == "shared" {
			t.Fatal("matched legacy price should become channel-specific")
		}
	}
	if !orphanFound {
		t.Fatal("unmatched legacy price must remain available in saved settings")
	}
	if !reflect.DeepEqual(normalizeModelCosts(costs, settings.Private.Channels), costs) {
		t.Fatal("normalizing migrated costs again should not change prices")
	}
}

func TestValidateUniqueModelChannelIDs(t *testing.T) {
	channels := []model.ModelChannel{{ID: "channel-same"}, {ID: "channel-same"}}
	if err := validateUniqueModelChannelIDs(channels); err == nil {
		t.Fatal("duplicate channel IDs must be rejected before saving prices")
	}
	channels[1].ID = "channel-other"
	if err := validateUniqueModelChannelIDs(channels); err != nil {
		t.Fatalf("distinct channel IDs: %v", err)
	}
	autoIDs := normalizePrivateSetting(model.PrivateSetting{Channels: []model.ModelChannel{
		{Name: "same", BaseURL: "https://example.com"},
		{Name: "same", BaseURL: "https://example.com"},
	}})
	if err := validateUniqueModelChannelIDs(autoIDs.Channels); err == nil {
		t.Fatal("colliding generated channel IDs must also be rejected")
	}
}

func TestVideoAndWorkflowPricesUseSelectedChannel(t *testing.T) {
	costs := []model.ModelCost{
		{ChannelID: "cheap", Model: "shared-video", Credits: 20},
		{ChannelID: "premium", Model: "shared-video", Credits: 86},
		{ChannelID: "cheap", Model: "workflow-model", Credits: 1},
		{ChannelID: "premium", Model: "workflow-model", Credits: 9},
	}
	if got := modelCostForChannel(costs, "premium", "shared-video"); got != 86 {
		t.Fatalf("selected video channel price = %d, want 86", got)
	}
	if got := modelCostForChannel(costs, "cheap", "workflow-model"); got != 1 {
		t.Fatalf("selected workflow channel price = %d, want 1", got)
	}
	if got := modelCostForChannel(costs, "other", "workflow-model"); got != 0 {
		t.Fatalf("unpriced workflow channel = %d, want 0", got)
	}
}

func TestPublicPricingCandidatesExcludeUnusableChannels(t *testing.T) {
	channels := []model.ModelChannel{
		{ID: "ready", Enabled: true, BaseURL: "https://example.com", APIKey: "key", Models: []string{"shared"}},
		{ID: "missing-key", Enabled: true, BaseURL: "https://example.com", Models: []string{"shared"}},
		{ID: "disabled", Enabled: false, BaseURL: "https://example.com", APIKey: "key", Models: []string{"shared"}},
	}
	infos := publicChannelInfos(channels)
	if len(infos) != 1 || infos[0].ID != "ready" {
		t.Fatalf("quote candidates = %#v, want only the selectable channel", infos)
	}
}

func TestWorkflowPricingUsesChannelScopedBillingName(t *testing.T) {
	channels := []model.ModelChannel{
		{
			ID:       "runninghub-a",
			Protocol: "runninghub",
			Workflows: []model.WorkflowEntry{{Provider: "runninghub", Kind: "workflow", WorkflowID: "wf-a", Enabled: true}},
		},
		{
			ID:       "runninghub-b",
			Protocol: "runninghub",
			Workflows: []model.WorkflowEntry{{Provider: "runninghub", Kind: "workflow", WorkflowID: "wf-a", Enabled: true}},
		},
	}
	billingName := workflowBillingName(WorkflowRef{Scope: "system", ChannelID: "runninghub-a", Kind: "workflow", WorkflowID: "wf-a"})
	costs := normalizeModelCosts([]model.ModelCost{{Model: billingName, Credits: 13}}, channels)
	if got := modelCostForChannel(costs, "runninghub-a", billingName); got != 13 {
		t.Fatalf("workflow legacy price = %d, want 13", got)
	}
	if got := modelCostForChannel(costs, "runninghub-b", billingName); got != 0 {
		t.Fatalf("workflow price must not leak to another channel = %d", got)
	}
	if got := modelCostForChannel(costs, "runninghub-b", workflowBillingName(WorkflowRef{Scope: "system", ChannelID: "runninghub-b", Kind: "workflow", WorkflowID: "wf-a"})); got != 0 {
		t.Fatalf("unpriced workflow channel = %d", got)
	}
}

func TestPublicChannelInfosIncludesAllowedWorkflowSummaries(t *testing.T) {
	ref := WorkflowRef{Scope: "system", ChannelID: "comfy-a", Kind: "workflow", WorkflowID: "portrait"}
	name := workflowBillingName(ref)
	infos := publicChannelInfos([]model.ModelChannel{{
		ID:       "comfy-a",
		Protocol: "comfyui",
		Workflows: []model.WorkflowEntry{{Provider: "comfyui", Kind: "workflow", WorkflowID: "portrait", Title: "Portrait", Capability: "image", Enabled: true}},
	}}, nil, []string{name})
	if len(infos) != 1 || len(infos[0].Workflows) != 1 || infos[0].Workflows[0].WorkflowID != "portrait" {
		t.Fatalf("workflow public config = %#v", infos)
	}
	if filtered := publicChannelInfos([]model.ModelChannel{{
		ID:       "comfy-a",
		Protocol: "comfyui",
		Workflows: []model.WorkflowEntry{{Provider: "comfyui", Kind: "workflow", WorkflowID: "portrait", Enabled: true}},
	}}, nil, []string{"workflow:system:comfy-a:workflow:other"}); len(filtered) != 0 {
		t.Fatalf("unlisted workflow should be hidden: %#v", filtered)
	}
}
