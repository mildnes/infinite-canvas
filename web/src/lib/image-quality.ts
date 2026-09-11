export const IMAGE_QUALITY_OPTIONS = [
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "极高" },
    { value: "max", label: "最高" },
    { value: "auto", label: "自动" },
] as const;

export type ImageQuality = (typeof IMAGE_QUALITY_OPTIONS)[number]["value"];

const IMAGE_QUALITY_VALUES = IMAGE_QUALITY_OPTIONS.map((item) => item.value);
const IMAGE_QUALITY_ALIASES: Record<string, ImageQuality> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
    standard: "low",
    hd: "medium",
};

export function normalizeImageQuality(quality: string | undefined | null): ImageQuality {
    const value = String(quality || "").trim().toLowerCase();
    if (!value || value === "auto") return "auto";
    const normalized = IMAGE_QUALITY_ALIASES[value] || value;
    return IMAGE_QUALITY_VALUES.includes(normalized as ImageQuality) ? normalized as ImageQuality : "auto";
}

export function imageQualityLabel(value: string) {
    return IMAGE_QUALITY_OPTIONS.find((item) => item.value === value)?.label || value;
}
