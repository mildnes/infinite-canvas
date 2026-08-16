package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type MCPToolCallRequest struct {
	ServerID  string         `json:"serverId"`
	ToolName  string         `json:"toolName"`
	Arguments map[string]any `json:"arguments"`
}

type MCPDiscoveryRequest struct {
	Server model.MCPServer `json:"server"`
}

func PublicAgentSettings(ctx context.Context) (model.PublicAgentSetting, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.PublicAgentSetting{}, err
	}
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return model.PublicAgentSetting{Skills: []model.AgentSkill{}, MCPServers: []model.PublicMCPServer{}}, nil
	}
	return publicAgentSettingForUser(normalizePrivateSetting(settings.Private).Agent, user.Role == model.UserRoleAdmin), nil
}

func CallMCPTool(ctx context.Context, request MCPToolCallRequest) (map[string]any, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return nil, err
	}
	settings.Private = normalizePrivateSetting(settings.Private)
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}
	var server *model.MCPServer
	for i := range settings.Private.Agent.MCPServers {
		item := &settings.Private.Agent.MCPServers[i]
		if item.ID == request.ServerID && item.Enabled && (user.Role == model.UserRoleAdmin || item.AllowUsers) {
			server = item
			break
		}
	}
	if server == nil || !mcpServerConfigured(*server) {
		return nil, errors.New("MCP 服务不存在或未启用")
	}
	allowed := false
	for _, tool := range server.Tools {
		if tool.Name == request.ToolName {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, errors.New("MCP 工具未在后台配置的工具清单中")
	}
	result, err := callMCPServer(ctx, *server, "tools/call", map[string]any{"name": request.ToolName, "arguments": request.Arguments})
	if err != nil {
		return nil, err
	}
	if rpcError, ok := result["error"].(map[string]any); ok {
		if message, ok := rpcError["message"].(string); ok && message != "" {
			return nil, errors.New(message)
		}
		return nil, errors.New("MCP 返回调用错误")
	}
	if payload, ok := result["result"].(map[string]any); ok {
		return payload, nil
	}
	return result, nil
}

func ListMCPTools(ctx context.Context, request MCPDiscoveryRequest) ([]model.MCPTool, error) {
	if strings.TrimSpace(request.Server.Endpoint) == "" {
		return nil, errors.New("请先填写 MCP 服务地址")
	}
	server := request.Server
	if strings.TrimSpace(server.APIKey) == "" {
		if settings, err := repository.GetSettings(); err == nil {
			for i := range settings.Private.Agent.MCPServers {
				item := settings.Private.Agent.MCPServers[i]
				if item.ID == server.ID || (item.Name == server.Name && item.Endpoint == server.Endpoint) {
					server.APIKey = item.APIKey
					break
				}
			}
		}
	}
	payload, err := callMCPServer(ctx, server, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	if rpcError, ok := payload["error"].(map[string]any); ok {
		if message, ok := rpcError["message"].(string); ok && message != "" {
			return nil, errors.New(message)
		}
		return nil, errors.New("MCP 返回工具列表错误")
	}
	result, _ := payload["result"].(map[string]any)
	rawTools, _ := result["tools"].([]any)
	tools := make([]model.MCPTool, 0, len(rawTools))
	for _, raw := range rawTools {
		item, _ := raw.(map[string]any)
		name := strings.TrimSpace(fmt.Sprint(item["name"]))
		if name == "" {
			continue
		}
		inputSchema, _ := item["inputSchema"].(map[string]any)
		if inputSchema == nil {
			inputSchema = map[string]any{}
		}
		tools = append(tools, model.MCPTool{
			Name:        name,
			Description: strings.TrimSpace(fmt.Sprint(item["description"])),
			InputSchema: inputSchema,
		})
	}
	return tools, nil
}

func publicAgentSettingForUser(setting model.PrivateAgentSetting, admin bool) model.PublicAgentSetting {
	result := model.PublicAgentSetting{Skills: []model.AgentSkill{}, MCPServers: []model.PublicMCPServer{}}
	for _, skill := range setting.Skills {
		if skill.Enabled && strings.TrimSpace(skill.Prompt) != "" {
			result.Skills = append(result.Skills, skill)
		}
	}
	for _, server := range setting.MCPServers {
		if !server.Enabled || !mcpServerConfigured(server) || (!admin && !server.AllowUsers) {
			continue
		}
		result.MCPServers = append(result.MCPServers, model.PublicMCPServer{ID: server.ID, Name: server.Name, Description: server.Description, Tools: server.Tools})
	}
	return result
}

func mcpServerConfigured(server model.MCPServer) bool {
	switch strings.ToLower(strings.TrimSpace(server.Transport)) {
	case mcpTransportStdio:
		return strings.TrimSpace(server.Command) != ""
	default:
		return strings.TrimSpace(server.Endpoint) != ""
	}
}

func decodeMCPJSON(body []byte, target *map[string]any) error {
	if err := json.Unmarshal(body, target); err == nil {
		return nil
	}
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		if err := json.Unmarshal([]byte(data), target); err == nil {
			return nil
		}
	}
	return errors.New("MCP 返回不是有效 JSON")
}
