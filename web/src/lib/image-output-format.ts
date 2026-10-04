import type { ModelChannelProtocol } from "@/lib/model-channel";
import type { WorkflowFieldMapping, WorkflowRef } from "@/lib/workflow-channel";
import sharedOutputCapabilityRules from "./image-output-capability-rules.json" with { type: "json" };

export type ImageOutputFormat = "png-transparent" | "jpeg";
export type ImageOutputFormatSelection = ImageOutputFormat | "auto";

export type ImageOutputCapability = {
    formats: ImageOutputFormat[];
    defaultFormat?: ImageOutputFormat;
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

type ImageOutputCapabilityRule = {
    id: string;
    channel: {
        protocols?: string[];
        baseUrlContains?: string[];
        combine?: "all" | "any";
    };
    excludeChannelContains?: string[];
    excludeModelRegex?: string;
    model: { kind: "prefix" | "regex" | "exact"; value: string; snapshotSuffix?: boolean };
    formats: string[];
    defaultFormat?: string;
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

export const imageOutputCapabilityRules = (sharedOutputCapabilityRules as { rules: ImageOutputCapabilityRule[] }).rules;
const compiledImageOutputCapabilityRules = imageOutputCapabilityRules.map((rule) => ({
    rule,
    modelRegex: rule.model.kind === "regex" ? new RegExp(rule.model.value) : undefined,
    excludeModelRegex: rule.excludeModelRegex ? new RegExp(rule.excludeModelRegex) : undefined,
}));

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
    const normalized = normalizeCapability(capability);
    if (!normalized?.formats.includes(format)) {
        if (!normalized?.defaultFormat) return { format: "auto" as const, fellBack: true, notice: "fallback-default" as const };
        return { format: normalized.defaultFormat, fellBack: true, notice: "fallback-default" as const };
    }
    return { format, fellBack: false };
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
        .map((channel) => {
            const declared = channel.imageOutputCapabilities?.[model];
            if (config.channelMode === "remote" || Object.hasOwn(channel.imageOutputCapabilities || {}, model)) {
                return normalizeCapability(declared);
            }
            return localImageOutputCapability(channel, model);
        })
        .filter((capability): capability is ImageOutputCapability => capability !== null);

    if (capabilities.length !== candidates.length) return null;
    if (!capabilities.length) return null;
    if (capabilities.length === 1) return capabilities[0];

    const formats = capabilities[0].formats.filter((format) => capabilities.every((capability) => capability.formats.includes(format)));
    const defaultFormat = capabilities.find((capability) => capability.defaultFormat && formats.includes(capability.defaultFormat))?.defaultFormat;
    return { formats, ...(defaultFormat ? { defaultFormat } : {}) };
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

function normalizeImageOutputModelName(model: string) {
    return model.toLowerCase().trim().replace(/[._/]/g, "-");
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
    const formats = Array.from(new Set(value.formats.filter((format): format is ImageOutputFormat => format === "png-transparent" || format === "jpeg")));
    const defaultFormat = formats.includes(value.defaultFormat as ImageOutputFormat) ? value.defaultFormat : undefined;
    return { formats, ...(defaultFormat ? { defaultFormat } : {}) };
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
    const protocol = String(channel.protocol || "openai").trim().toLowerCase();
    const normalizedModel = normalizeImageOutputModelName(model);
    const baseUrl = String(channel.baseUrl || "").trim().toLowerCase();
    const channelHint = `${baseUrl} ${channel.name || ""}`.toLowerCase().trim();
    const match = compiledImageOutputCapabilityRules.find(({ rule, modelRegex, excludeModelRegex }) => {
        if (rule.excludeChannelContains?.some((value) => channelHint.includes(value.toLowerCase().trim()))) return false;
        const channelConditions: boolean[] = [];
        if (rule.channel.protocols?.length) channelConditions.push(rule.channel.protocols.includes(protocol));
        if (rule.channel.baseUrlContains?.length) channelConditions.push(rule.channel.baseUrlContains.some((value) => baseUrl.includes(value.toLowerCase().trim())));
        const channelMatches = channelConditions.length === 0 || (rule.channel.combine === "any" ? channelConditions.some(Boolean) : channelConditions.every(Boolean));
        if (!channelMatches) return false;
        const modelMatches = rule.model.kind === "prefix"
            ? normalizedModel.startsWith(normalizeImageOutputModelName(rule.model.value))
            : rule.model.kind === "exact"
                ? normalizedModel === normalizeImageOutputModelName(rule.model.value)
                : matchesRuleRegex(normalizedModel, modelRegex, rule.model.snapshotSuffix === true);
        return modelMatches
            && excludeModelRegex?.test(normalizedModel) !== true;
    });
    if (!match) return null;
    const formats = Array.from(new Set(match.rule.formats.filter((format): format is ImageOutputFormat => format === "png-transparent" || format === "jpeg")));
    const defaultFormat = formats.includes(match.rule.defaultFormat as ImageOutputFormat) ? match.rule.defaultFormat as ImageOutputFormat : undefined;
    return { formats, ...(defaultFormat ? { defaultFormat } : {}) };
}

function matchesRuleRegex(model: string, regex: RegExp | undefined, allowSnapshotSuffix: boolean) {
    if (!regex) return false;
    if (regex.test(model)) return true;
    if (!allowSnapshotSuffix) return false;
    const match = model.match(/-(\d{4}-\d{2}-\d{2})$/);
    if (!match) return false;
    const date = new Date(`${match[1]}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) return false;
    return regex.test(model.slice(0, -11));
}
