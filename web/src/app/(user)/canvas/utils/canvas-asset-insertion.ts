import type { InsertAssetPayload } from "../types";
import { stableAssetUrl } from "@/lib/asset-data";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";

export async function resolveCanvasAssetPayload(payload: InsertAssetPayload): Promise<InsertAssetPayload> {
    if (payload.kind === "text") return payload;
    const fallback = stableAssetUrl(payload.storageKey, payload.kind === "image" ? payload.dataUrl : payload.url);
    const resolved = payload.kind === "image" ? await resolveImageUrl(payload.storageKey, fallback) : await resolveMediaUrl(payload.storageKey, fallback);
    const url = /^server:([A-Za-z0-9_-]+)$/.test(payload.storageKey || "") ? stableAssetUrl(payload.storageKey) : resolved;
    if (!url) throw new Error("素材暂时无法读取，请在素材库恢复文件或重新上传后重试插入");
    return { ...payload, ...(payload.kind === "image" ? { dataUrl: url } : { url }) } as InsertAssetPayload;
}
