import type { CanvasAgentConfig, CanvasAgentProtocolMessage, CanvasAssistantSession } from "../types";

export const MAX_CANVAS_AGENT_SKILLS = 5;

export type CanvasAgentSkillSelection = {
    id: string;
    name: string;
    description?: string;
    source: "system" | "user" | "builtin" | "admin";
};

export type CanvasAgentConfigCompat = CanvasAgentConfig & {
    textApiMode?: "chat" | "responses";
    autoGenerateMedia?: boolean;
};

export type CanvasAssistantSessionCompat = CanvasAssistantSession & {
    activeSkills?: CanvasAgentSkillSelection[];
    contextCheckpoint?: string;
};

export type CanvasAgentAssistantProtocolMessage = Extract<CanvasAgentProtocolMessage, { role: "assistant" }> & {
    responseItems?: unknown[];
};

export function responseItemsOf(message: CanvasAgentProtocolMessage) {
    return message.role === "assistant" ? (message as CanvasAgentAssistantProtocolMessage).responseItems : undefined;
}
