import type { Asset } from "@/stores/use-asset-store";

export type AssetTombstone = { id: string; deletedAt: string };
export type AssetSnapshot = { assets: Asset[]; tombstones?: AssetTombstone[]; revision?: string };
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const timestamp = (value?: string) => Date.parse(value || "") || 0;

export function stableAssetUrl(storageKey?: string, fallback = "") {
    const id = /^server:([A-Za-z0-9_-]+)$/.exec(storageKey || "")?.[1];
    return id ? `/api/files/${id}/content` : typeof fallback !== "string" || /^blob:/i.test(fallback) ? "" : fallback;
}

// Object URLs belong to the current document; never store or sync them.
export function normalizeAsset(asset: Asset): Asset {
    if (asset.kind === "text") return { ...asset, coverUrl: stableAssetUrl(undefined, asset.coverUrl || "") };
    const url = stableAssetUrl(asset.data.storageKey, asset.kind === "image" ? asset.data.dataUrl : asset.data.url);
    const coverUrl = asset.data.storageKey
        ? stableAssetUrl(asset.data.storageKey, asset.coverUrl || "") || url
        : stableAssetUrl(undefined, asset.coverUrl || "") || url;
    return {
        ...asset,
        coverUrl: coverUrl || (asset.kind === "image" ? url : ""),
        data: { ...asset.data, ...(asset.kind === "image" ? { dataUrl: url } : { url }) },
    } as Asset;
}

export function mergeAssets(remoteAssets: Asset[], localAssets: Asset[], tombstones: AssetTombstone[] = []) {
    const records = new Map<string, Asset>();
    for (const asset of [...localAssets, ...remoteAssets]) {
        if (!asset?.id) continue;
        const previous = records.get(asset.id);
        if (!previous || timestamp(asset.updatedAt) >= timestamp(previous.updatedAt)) records.set(asset.id, normalizeAsset(asset));
    }
    for (const tombstone of tombstones) {
        const asset = records.get(tombstone.id);
        if (asset && timestamp(tombstone.deletedAt) >= timestamp(asset.updatedAt)) records.delete(tombstone.id);
    }
    return [...records.values()].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt) || a.id.localeCompare(b.id));
}

export function mergeAssetSnapshots(remote?: Partial<AssetSnapshot> | null, local?: Partial<AssetSnapshot> | null, now = Date.now()): AssetSnapshot {
    const deletions = new Map<string, AssetTombstone>();
    for (const tombstone of [...(Array.isArray(local?.tombstones) ? local.tombstones : []), ...(Array.isArray(remote?.tombstones) ? remote.tombstones : [])]) {
        if (!tombstone?.id || !timestamp(tombstone.deletedAt)) continue;
        const previous = deletions.get(tombstone.id);
        if (!previous || timestamp(tombstone.deletedAt) > timestamp(previous.deletedAt)) deletions.set(tombstone.id, tombstone);
    }
    // Apply even expired deletions once before pruning, so this merge cannot resurrect them.
    const assets = mergeAssets(Array.isArray(remote?.assets) ? remote.assets : [], Array.isArray(local?.assets) ? local.assets : [], [...deletions.values()]);
    const tombstones = [...deletions.values()].filter(item => timestamp(item.deletedAt) >= now - TOMBSTONE_RETENTION_MS).sort((a, b) => a.id.localeCompare(b.id));
    return { assets, tombstones };
}
