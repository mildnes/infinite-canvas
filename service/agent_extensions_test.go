package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestStreamableHTTPMCPInitializeListAndCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		switch payload["method"] {
		case "initialize":
			writer.Header().Set("Mcp-Session-Id", "session-1")
			_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}`))
		case "notifications/initialized":
			writer.WriteHeader(http.StatusAccepted)
		case "tools/list":
			writer.Header().Set("Content-Type", "text/event-stream")
			_, _ = writer.Write([]byte("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"generate_video\",\"inputSchema\":{\"type\":\"object\"}}]}}\n\n"))
		case "tools/call":
			_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"ok"}]}}`))
		default:
			http.Error(writer, "unknown method", http.StatusBadRequest)
		}
	}))
	defer server.Close()

	config := model.MCPServer{ID: "http-test", Transport: "streamable_http", Endpoint: server.URL}
	list, err := callMCPServer(t.Context(), config, "tools/list", map[string]any{})
	if err != nil {
		t.Fatalf("tools/list error = %v", err)
	}
	if result, ok := list["result"].(map[string]any); !ok || result["tools"] == nil {
		t.Fatalf("tools/list result = %#v", list)
	}
	call, err := callMCPServer(t.Context(), config, "tools/call", map[string]any{"name": "generate_video"})
	if err != nil {
		t.Fatalf("tools/call error = %v", err)
	}
	if call["result"] == nil {
		t.Fatalf("tools/call result = %#v", call)
	}
}

func TestStdioMCPProcessCanReuseClient(t *testing.T) {
	client, err := startStdioMCPClient(model.MCPServer{ID: "stdio-test", Transport: "stdio", Command: "cat"})
	if err != nil {
		t.Fatalf("start stdio MCP = %v", err)
	}
	defer client.close()
	first, err := client.call(t.Context(), "tools/list", map[string]any{})
	if err != nil {
		t.Fatalf("first stdio call = %v", err)
	}
	second, err := client.call(t.Context(), "tools/call", map[string]any{})
	if err != nil {
		t.Fatalf("second stdio call = %v", err)
	}
	if first["id"] == nil || second["id"] == nil {
		t.Fatalf("stdio responses missing ids: %#v %#v", first, second)
	}
}

func TestNormalizeGitHubSkillSource(t *testing.T) {
	rawURL, repositoryURL, ref, skillPath, err := normalizeGitHubSkillSource(RemoteAgentSkillRequest{
		Repository: "https://github.com/acme/video-skills/blob/main/skills/video/SKILL.md",
	})
	if err != nil {
		t.Fatalf("normalizeGitHubSkillSource() error = %v", err)
	}
	if rawURL != "https://raw.githubusercontent.com/acme/video-skills/main/skills/video/SKILL.md" {
		t.Fatalf("raw URL = %q", rawURL)
	}
	if repositoryURL != "https://github.com/acme/video-skills" || ref != "main" || skillPath != "skills/video/SKILL.md" {
		t.Fatalf("source = %q %q %q", repositoryURL, ref, skillPath)
	}
}

func TestSplitSkillFrontMatter(t *testing.T) {
	frontMatter, prompt := splitSkillFrontMatter("---\nname: 视频工作流\ndescription: 自动生成视频\n---\n\n请先拆分镜头。")
	if frontMatter["name"] != "视频工作流" || frontMatter["description"] != "自动生成视频" {
		t.Fatalf("front matter = %#v", frontMatter)
	}
	if prompt != "请先拆分镜头。" {
		t.Fatalf("prompt = %q", prompt)
	}
}
