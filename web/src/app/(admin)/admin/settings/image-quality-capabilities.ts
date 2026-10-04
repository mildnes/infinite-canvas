import type { ImageQualityCapabilities } from "@/lib/image-quality";

export function normalizeImageQualityCapabilities(capabilities: ImageQualityCapabilities | undefined, models: string[]) {
    if (!capabilities) return undefined;
    const modelSet = new Set(models);
    const result: ImageQualityCapabilities = {};
    for (const [model, capability] of Object.entries(capabilities)) {
        if (!modelSet.has(model) || !capability) continue;
        const values = Array.from(new Set((capability.values || []).map((value) => String(value).trim()).filter(Boolean)));
        const map = Object.fromEntries(Object.entries(capability.map || {})
            .map(([key, value]) => [key.trim().toLowerCase(), String(value).trim()] as const)
            .filter(([key, value]) => key && value && values.includes(value)));
        const defaultValue = values.includes(capability.defaultValue || "") ? capability.defaultValue : undefined;
        result[model] = { values, ...(Object.keys(map).length ? { map } : {}), ...(defaultValue ? { defaultValue } : {}) };
    }
    return Object.keys(result).length ? result : undefined;
}
