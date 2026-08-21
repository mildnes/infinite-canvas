export type ModelChannelProtocol = "openai" | "grok2api" | "metaso" | "apimart" | "kie" | "mimo";

export const modelChannelDefaultBaseUrls: Record<ModelChannelProtocol, string> = {
    openai: "https://api.openai.com",
    grok2api: "",
    metaso: "https://metaso.cn/api/minimax",
    apimart: "https://api.apimart.ai/v1",
    kie: "https://api.kie.ai/api/v1",
    mimo: "https://api.xiaomimimo.com",
};
