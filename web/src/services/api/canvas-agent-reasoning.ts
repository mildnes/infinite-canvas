export type CanvasAgentReasoningMode = "chat" | "responses" | "gemini";

export function applyCanvasAgentReasoning(
    body: Record<string, unknown>,
    options: { enabled: boolean; mode: CanvasAgentReasoningMode; model: string; protocol?: string },
) {
    if (!options.enabled) return body;
    if (options.mode === "responses") body.reasoning = { effort: "high" };
    else if (options.mode === "gemini") {
        body.generationConfig = {
            ...((body.generationConfig as Record<string, unknown> | undefined) || {}),
            thinkingConfig: options.model.toLowerCase().includes("2.5") ? { thinkingBudget: -1 } : { thinkingLevel: "high" },
        };
    } else if (options.protocol === "mimo") body.thinking = { type: "enabled" };
    else body.reasoning_effort = "high";
    return body;
}
