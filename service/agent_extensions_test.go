package service

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestDecodeMCPJSONSupportsJSONAndSSE(t *testing.T) {
	for name, body := range map[string][]byte{
		"json": []byte(`{"jsonrpc":"2.0","result":{"tools":[]}}`),
		"sse":  []byte("event: message\ndata: {\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]}}\n\n"),
	} {
		t.Run(name, func(t *testing.T) {
			var payload map[string]any
			if err := decodeMCPJSON(body, &payload); err != nil {
				t.Fatalf("decodeMCPJSON() error = %v", err)
			}
			if payload["jsonrpc"] != "2.0" {
				t.Fatalf("jsonrpc = %v, want 2.0", payload["jsonrpc"])
			}
		})
	}
}

func TestPublicAgentSettingForUserFiltersMCPAccess(t *testing.T) {
	setting := model.PrivateAgentSetting{
		Skills: []model.AgentSkill{{ID: "skill-1", Name: "视频工作流", Prompt: "按步骤执行", Enabled: true}},
		MCPServers: []model.MCPServer{
			{ID: "public", Name: "公共视频", Endpoint: "https://example.com/public", Enabled: true, AllowUsers: true},
			{ID: "admin", Name: "管理员视频", Endpoint: "https://example.com/admin", Enabled: true, AllowUsers: false},
		},
	}
	regular := publicAgentSettingForUser(setting, false)
	if len(regular.Skills) != 1 || len(regular.MCPServers) != 1 || regular.MCPServers[0].ID != "public" {
		t.Fatalf("regular user result = %#v, want one skill and one public MCP", regular)
	}
	admin := publicAgentSettingForUser(setting, true)
	if len(admin.MCPServers) != 2 {
		t.Fatalf("admin MCP count = %d, want 2", len(admin.MCPServers))
	}
}
