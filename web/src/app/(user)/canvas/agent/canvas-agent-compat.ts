import { MAX_CANVAS_AGENT_SKILLS, type CanvasAgentConfig, type CanvasAgentProtocolMessage, type CanvasAgentSkillSelection, type CanvasAssistantSession } from "../types";

export { MAX_CANVAS_AGENT_SKILLS };
export type { CanvasAgentSkillSelection };

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
