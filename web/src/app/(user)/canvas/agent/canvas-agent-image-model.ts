import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasAgentConfig } from "../types";

export function resolveCanvasAgentImageSelection(config: AiConfig, agentConfig?: CanvasAgentConfig | null) {
    const channels: Array<{ id?: string; models?: string[]; modelCapabilities?: Record<string, string[]> }> = config.channelMode === "remote"
        ? config.publicChannels
        : config.localChannels.length
            ? config.localChannels
            : [{ id: "local-default", models: config.models }];
    const legacyImageModels = new Set(config.imageModels);
    const requestedModel = agentConfig?.imageModel || "";
    const supportsImage = (channel: (typeof channels)[number], model: string) => {
        if (!channel.models?.includes(model)) return false;
        const declaredCapabilities = channel.modelCapabilities?.[model];
        if (Array.isArray(declaredCapabilities)) return declaredCapabilities.includes("image");
        if (channels.some((candidate) => Array.isArray(candidate.modelCapabilities?.[model]))) return false;
        return legacyImageModels.has(model);
    };
    const requestedIsAvailable = Boolean(requestedModel && channels.some((channel) => supportsImage(channel, requestedModel)));
    const defaultIsAvailable = channels.some((channel) => supportsImage(channel, config.imageModel));
    const firstImageModel = channels.flatMap((channel) => (channel.models || []).filter((model) => supportsImage(channel, model)))[0];
    const imageModel = requestedIsAvailable
        ? requestedModel
        : defaultIsAvailable
            ? config.imageModel
            : firstImageModel || config.imageModel;
    const modelChannels = channels.filter((channel) => supportsImage(channel, imageModel));
    const requestedChannel = modelChannels.find((channel) => channel.id === agentConfig?.imageChannelId);
    const defaultChannel = modelChannels.find((channel) => channel.id === config.imageChannelId);
    return {
        imageModel,
        imageChannelId: requestedChannel?.id || defaultChannel?.id || modelChannels[0]?.id || config.imageChannelId,
        imageOutputFormat: agentConfig ? agentConfig.imageOutputFormat || "auto" : config.imageOutputFormat || "auto",
    };
}

export function applyCanvasAgentImageSelection(config: AiConfig, selection: Pick<CanvasAgentConfig, "imageModel" | "imageChannelId" | "imageOutputFormat">): AiConfig {
    return {
        ...config,
        imageModel: selection.imageModel || config.imageModel,
        imageChannelId: selection.imageChannelId || config.imageChannelId,
        imageOutputFormat: selection.imageOutputFormat || config.imageOutputFormat || "auto",
    };
}
