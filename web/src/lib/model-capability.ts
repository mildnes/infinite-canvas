export type ModelCapability = "image" | "video" | "text" | "audio";

export type ModelCapabilities = Record<string, ModelCapability[]>;
