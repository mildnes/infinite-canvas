import type { Asset } from "@/stores/use-asset-store";
import { normalizeAsset } from "@/lib/asset-data";
import { uploadImage } from "@/services/image-storage";
import { uploadAssetMediaFile } from "@/services/file-storage";

export async function prepareAssetForSave(asset: Asset): Promise<Asset> {
    if (asset.kind === "text" || asset.data.storageKey) return normalizeAsset(asset);
    const url = (asset.kind === "image" ? asset.data.dataUrl : asset.data.url) || "";
    if (!/^(blob|data):/i.test(url)) return normalizeAsset(asset);
    if (asset.kind === "image") {
        const stored = await uploadImage(url);
        return normalizeAsset({ ...asset, data: { ...asset.data, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType } });
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error("素材读取失败，请重新选择文件后保存");
    const blob = await response.blob();
    const stored = await uploadAssetMediaFile(new File([blob], asset.title, { type: blob.type || asset.data.mimeType }), asset.kind === "video" ? "asset-video" : "asset-audio");
    return normalizeAsset({ ...asset, data: { ...asset.data, url: stored.url, storageKey: stored.storageKey, bytes: stored.bytes, mimeType: stored.mimeType } } as Asset);
}
