import type { ModelChannelProtocol } from "@/lib/model-channel";
import type { WorkflowFieldMapping, WorkflowRef } from "@/lib/workflow-channel";

export type ImageOutputFormat = "png-transparent" | "jpeg";
export type ImageOutputFormatSelection = ImageOutputFormat | "auto";

export type ImageOutputCapability = {
    formats: ImageOutputFormat[];
    defaultFormat: ImageOutputFormat;
};

export type ImageOutputCapabilities = Record<string, ImageOutputCapability>;

type ImageOutputChannel = {
    id?: string;
    protocol?: ModelChannelProtocol;
    baseUrl?: string;
    name?: string;
    models?: string[];
    enabled?: boolean;
    imageOutputCapabilities?: ImageOutputCapabilities;
    workflows?: ImageOutputWorkflowSummary[];
    workflowSummaries?: ImageOutputWorkflowSummary[];
};

type ImageOutputWorkflowSummary = {
    kind: string;
    workflowId: string;
    enabled?: boolean;
    imageOutputCapability?: ImageOutputCapability;
};

export type ImageOutputConfig = {
    channelMode?: "remote" | "local";
    model?: string;
    imageModel?: string;
    imageWorkflowRef?: WorkflowRef;
    imageChannelId?: string;
    activeChannelId?: string;
    publicChannels?: ImageOutputChannel[];
    localChannels?: ImageOutputChannel[];
};

export const imageOutputFormatOptions: Array<{ value: ImageOutputFormat; label: string }> = [
    { value: "png-transparent", label: "透明 PNG" },
    { value: "jpeg", label: "JPG" },
];

export function normalizeImageOutputFormat(value: unknown): ImageOutputFormatSelection {
    return value === "png-transparent" || value === "jpeg" ? value : "auto";
}

export function resolveImageOutputFormat(selection: unknown, capability: ImageOutputCapability | null | undefined) {
    const format = normalizeImageOutputFormat(selection);
    if (!capability || format === "auto") return { format: "auto" as const, fellBack: false };
    if (capability.formats.includes(format)) return { format, fellBack: false };
    return { format: capability.defaultFormat, fellBack: true };
}

export function imageOutputCapabilityForConfig(config: ImageOutputConfig, model = config.imageModel || config.model || ""): ImageOutputCapability | null {
    if (config.imageWorkflowRef) return workflowCapabilityForConfig(config).capability;
    if (!model) return null;
    const channels = config.channelMode === "remote" ? config.publicChannels || [] : config.localChannels || [];
    const matchingChannels = channels.filter((channel) => channel.enabled !== false && channel.models?.includes(model));
    const selectedChannelId = config.imageChannelId || "";
    const activeChannel = !selectedChannelId && config.activeChannelId ? matchingChannels.find((channel) => channel.id === config.activeChannelId) : undefined;
    const selectedChannel = selectedChannelId ? matchingChannels.find((channel) => channel.id === selectedChannelId) : activeChannel;
    const candidates = selectedChannelId ? (selectedChannel ? [selectedChannel] : []) : selectedChannel ? [selectedChannel] : matchingChannels;
    const capabilities = candidates
        .map((channel) => config.channelMode === "remote"
            ? normalizeCapability(channel.imageOutputCapabilities?.[model])
            : localImageOutputCapability(channel, model))
        .filter((capability): capability is ImageOutputCapability => capability !== null);

    if (capabilities.length !== candidates.length) return null;
    if (!capabilities.length) return null;
    if (capabilities.length === 1) return capabilities[0];

    const formats = capabilities[0].formats.filter((format) => capabilities.every((capability) => capability.formats.includes(format)));
    if (!formats.length) return null;
    const defaultFormat = capabilities[0].defaultFormat && formats.includes(capabilities[0].defaultFormat)
        ? capabilities[0].defaultFormat
        : formats[0];
    return { formats, defaultFormat };
}

export function hasImageOutputFormatContext(config: ImageOutputConfig, model = config.imageModel || config.model || "") {
    if (config.imageWorkflowRef) return workflowCapabilityForConfig(config).found;
    if (!model) return false;
    const channels = config.channelMode === "remote" ? config.publicChannels || [] : config.localChannels || [];
    const matchingChannels = channels.filter((channel) => channel.enabled !== false && channel.models?.includes(model));
    return config.imageChannelId
        ? matchingChannels.some((channel) => channel.id === config.imageChannelId)
        : matchingChannels.length > 0;
}

export function imageOutputCapabilityForWorkflowFields(fields: WorkflowFieldMapping[]): ImageOutputCapability | undefined {
    const enabledFields = fields.filter((field) => field.enabled !== false && field.safeToOverride !== false);
    const formatFields = enabledFields.filter((field) => ["outputformat", "imageoutputformat"].includes(String(field.source || "").trim().toLowerCase()));
    if (!formatFields.length) return undefined;
    const supports = (field: WorkflowFieldMapping, values: string[]) => (field.options || []).some((option) => {
        const value = workflowScalarOption(option);
        return value !== null && values.includes(value.trim().toLowerCase());
    });
    const formats: ImageOutputFormat[] = [];
    const transparentFields = enabledFields.filter((field) => String(field.source || "").trim().toLowerCase() === "transparentbackground");
    const supportsBooleanValue = (field: WorkflowFieldMapping, value: "true" | "false") => {
        if (field.options?.length) return supports(field, [value]);
        const fieldType = String(field.fieldType || "").trim().toLowerCase();
        return fieldType === "boolean" || fieldType === "bool";
    };
    const supportsTransparentBackground = transparentFields.length > 0 && transparentFields.every((field) => supportsBooleanValue(field, "true"));
    if (formatFields.every((field) => supports(field, ["png"])) && supportsTransparentBackground) formats.push("png-transparent");
    if (formatFields.every((field) => supports(field, ["jpeg", "jpg"])) && transparentFields.every((field) => supportsBooleanValue(field, "false"))) formats.push("jpeg");
    return formats.length ? { formats, defaultFormat: formats[0] } : undefined;
}

function isImageModelFamilyOrSnapshot(value: string, family: string) {
    if (value === family) return true;
    const suffix = value.startsWith(`${family}-`) ? value.slice(family.length + 1) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(suffix)) return false;
    const snapshotDate = new Date(`${suffix}T00:00:00.000Z`);
    return !Number.isNaN(snapshotDate.getTime()) && snapshotDate.toISOString().slice(0, 10) === suffix;
}

function isOpenAIGPTImageModel(model: string) {
    return ["gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]
        .some((family) => isImageModelFamilyOrSnapshot(model, family));
}

function normalizeImageOutputModelName(model: string) {
    return model.toLowerCase().trim().replace(/[._/]/g, "-");
}

function isAPIMartOutputFormatModel(model: string) {
    const normalized = normalizeImageOutputModelName(model);
    return normalized.includes("gpt-image-1") || normalized.includes("gpt-image-2") && normalized.split("-").includes("official");
}

function isAPIMartSeedreamOutputFormatModel(model: string) {
    const normalized = normalizeImageOutputModelName(model);
    return normalized.includes("seedream-5") && !normalized.includes("seedream-5-0-pro");
}

function workflowCapabilityForConfig(config: ImageOutputConfig) {
    const ref = config.imageWorkflowRef;
    if (!ref) return { found: false, capability: null };
    const channels = ref.scope === "system" ? config.publicChannels || [] : config.localChannels || [];
    const channel = channels.find((item) => item.id === ref.channelId && item.enabled !== false);
    const workflows = ref.scope === "system" ? channel?.workflows : channel?.workflowSummaries;
    const workflow = workflows?.find((item) => item.kind === ref.kind && item.workflowId === ref.workflowId);
    return { found: Boolean(workflow), capability: workflow?.enabled === false ? null : normalizeCapability(workflow?.imageOutputCapability) };
}

function normalizeCapability(value: ImageOutputCapability | undefined): ImageOutputCapability | null {
    if (!value || !Array.isArray(value.formats)) return null;
    const formats = value.formats.filter((format): format is ImageOutputFormat => format === "png-transparent" || format === "jpeg");
    if (!formats.length) return null;
    const defaultFormat = formats.includes(value.defaultFormat) ? value.defaultFormat : formats[0];
    return { formats, defaultFormat };
}

function workflowScalarOption(option: unknown): string | null {
    if (option === null || option === undefined) return null;
    if (typeof option === "object" && !Array.isArray(option)) {
        const item = option as Record<string, unknown>;
        if (["min", "max", "step", "minValue", "maxValue", "stepValue", "range"].some((key) => key in item)) return null;
        for (const key of ["value", "id", "key", "name", "label"]) {
            if (item[key] !== undefined && item[key] !== null) return String(item[key]);
        }
        return null;
    }
    return String(option);
}

function localImageOutputCapability(channel: ImageOutputChannel, model: string): ImageOutputCapability | null {
    const protocol = channel.protocol || "openai";
    const normalizedModel = model.toLowerCase().trim();
    const endpoint = `${channel.baseUrl || ""} ${channel.name || ""}`.toLowerCase();
    if (protocol === "openai" && !endpoint.includes("x.ai") && !endpoint.includes("grok2api") && isOpenAIGPTImageModel(normalizedModel)) {
        return { formats: ["png-transparent", "jpeg"], defaultFormat: "png-transparent" };
    }

    if (protocol === "apimart" && (isAPIMartOutputFormatModel(normalizedModel) || isAPIMartSeedreamOutputFormatModel(normalizedModel))) {
        return { formats: ["jpeg"], defaultFormat: "jpeg" };
    }

    if ((protocol === "kie" || endpoint.includes("kie.ai")) && [
        "nano-banana-2",
        "nano-banana-pro",
        "google/nano-banana",
        "google/nano-banana-edit",
        "qwen/text-to-image",
        "qwen/image-edit",
        "qwen/image-to-image",
        "qwen2/image-edit",
        "qwen2/text-to-image",
    ].includes(normalizedModel.replace(/^kie\//, ""))) {
        return { formats: ["jpeg"], defaultFormat: "jpeg" };
    }

    return null;
}
