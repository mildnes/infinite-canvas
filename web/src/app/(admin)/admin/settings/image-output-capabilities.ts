import type { ImageOutputCapabilities, ImageOutputFormat } from "@/lib/image-output-format";

const supportedFormats = new Set<ImageOutputFormat>(["png-transparent", "png", "jpeg"]);

export function normalizeImageOutputCapabilities(capabilities: ImageOutputCapabilities | undefined, models: string[]) {
    if (!capabilities) return undefined;
    const modelSet = new Set(models);
    const result: ImageOutputCapabilities = {};
    for (const [model, capability] of Object.entries(capabilities)) {
        if (!modelSet.has(model) || !capability || !Array.isArray(capability.formats)) continue;
        const formats = Array.from(new Set(capability.formats.filter((format) => supportedFormats.has(format))));
        const defaultFormat = formats.includes(capability.defaultFormat as ImageOutputFormat) ? capability.defaultFormat : undefined;
        result[model] = { formats, ...(defaultFormat ? { defaultFormat } : {}) };
    }
    return Object.keys(result).length ? result : undefined;
}
