import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasAgentConfig } from "../types";

export function resolveCanvasAgentImageSelection(config: AiConfig, agentConfig?: CanvasAgentConfig | null) {
    const channels = config.channelMode === "remote" ? config.publicChannels : config.localChannels.length ? config.localChannels : [{ id: "local-default", models: config.models }];
    const allowedModels = new Set(config.imageModels);
    const requestedModel = agentConfig?.imageModel || "";
    const requestedIsAvailable = Boolean(requestedModel && allowedModels.has(requestedModel) && channels.some((channel) => channel.models?.includes(requestedModel)));
    const imageModel = requestedIsAvailable ? requestedModel : config.imageModel;
    const modelChannels = channels.filter((channel) => channel.models?.includes(imageModel));
    const requestedChannel = modelChannels.find((channel) => channel.id === agentConfig?.imageChannelId);
    const defaultChannel = modelChannels.find((channel) => channel.id === config.imageChannelId);
    return {
        imageModel,
        imageChannelId: requestedChannel?.id || defaultChannel?.id || modelChannels[0]?.id || config.imageChannelId,
    };
}

export function applyCanvasAgentImageSelection(config: AiConfig, selection: Pick<CanvasAgentConfig, "imageModel" | "imageChannelId">): AiConfig {
    return {
        ...config,
        imageModel: selection.imageModel || config.imageModel,
        imageChannelId: selection.imageChannelId || config.imageChannelId,
    };
}
