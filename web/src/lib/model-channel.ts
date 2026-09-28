export const modelChannelProtocols = [
    { value: "openai", label: "OpenAI", baseUrl: "https://api.openai.com" },
    { value: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com" },
    { value: "grok2api", label: "Grok2API", baseUrl: "" },
    { value: "xai", label: "xAI", baseUrl: "https://api.x.ai" },
    { value: "metaso", label: "MiniMax & METASO", baseUrl: "https://metaso.cn/api/minimax", apiKeyUrl: "https://metaso.cn/minimax-h3/?s=tt" },
    { value: "apimart", label: "APIMart", baseUrl: "https://api.apimart.ai/v1", apiKeyUrl: "https://apimart.ai/register?aff=fWMrEv", directRequestPlan: true },
    { value: "kie", label: "KIE", baseUrl: "https://api.kie.ai/api/v1", directRequestPlan: true },
    { value: "mimo", label: "MiMo", baseUrl: "https://api.xiaomimimo.com", apiKeyUrl: "https://platform.xiaomimimo.com/?ref=JFZQR2" },
    { value: "ark", label: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", directRequestPlan: true },
    { value: "runninghub", label: "RunningHub", baseUrl: "https://www.runninghub.cn" },
    { value: "comfyui", label: "ComfyUI", baseUrl: "" },
] as const;

export type ModelChannelProtocol = (typeof modelChannelProtocols)[number]["value"];
export type DirectAIProvider = Extract<(typeof modelChannelProtocols)[number], { directRequestPlan: true }>["value"];
export const modelChannelProtocolOptions = modelChannelProtocols.map(({ value, label }) => ({ label, value }));
export const modelChannelDefaultBaseUrls = Object.fromEntries(modelChannelProtocols.map(({ value, baseUrl }) => [value, baseUrl])) as Record<ModelChannelProtocol, string>;
export const modelChannelApiKeyUrls = Object.fromEntries(modelChannelProtocols.flatMap((protocol) => "apiKeyUrl" in protocol ? [[protocol.value, protocol.apiKeyUrl]] : [])) as Partial<Record<ModelChannelProtocol, string>>;

const directRequestProviders: ReadonlySet<string> = new Set(modelChannelProtocols.flatMap((protocol) => "directRequestPlan" in protocol && protocol.directRequestPlan === true ? [protocol.value] : []));

export function directAIProviderForProtocol(protocol: string): DirectAIProvider | null {
    return directRequestProviders.has(protocol) ? protocol as DirectAIProvider : null;
}

export function isWorkflowProtocol(protocol: string): protocol is "runninghub" | "comfyui" {
    return protocol === "runninghub" || protocol === "comfyui";
}
