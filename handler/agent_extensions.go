package handler

import (
	"encoding/json"
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

func AgentSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := service.PublicAgentSettings(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, settings)
}

func CallAgentMCPTool(w http.ResponseWriter, r *http.Request) {
	var request service.MCPToolCallRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "MCP 工具参数格式错误")
		return
	}
	result, err := service.CallMCPTool(r.Context(), request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminListMCPTools(w http.ResponseWriter, r *http.Request) {
	var request service.MCPDiscoveryRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "MCP 服务参数格式错误")
		return
	}
	tools, err := service.ListMCPTools(r.Context(), request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, tools)
}
