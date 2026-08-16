import { apiGet, apiPost } from "./request";

export type AgentSkill = { id: string; name: string; description: string; prompt: string; enabled: boolean };
export type AgentMCPTool = { name: string; description: string; inputSchema?: Record<string, unknown> };
export type AgentMCPServer = { id: string; name: string; description: string; tools: AgentMCPTool[] };
export type AgentSettings = { skills: AgentSkill[]; mcpServers: AgentMCPServer[] };

export function fetchAgentSettings(token?: string) {
    return apiGet<AgentSettings>("/api/agent/settings", undefined, token);
}

export function callAgentMCPTool(token: string, payload: { serverId: string; toolName: string; arguments: Record<string, unknown> }) {
    return apiPost<Record<string, unknown>>("/api/v1/agent/mcp/call", payload, token);
}
