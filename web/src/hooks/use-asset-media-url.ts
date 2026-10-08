"use client";

import { useEffect, useState } from "react";
import { stableAssetUrl } from "@/lib/asset-data";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { useUserStore } from "@/stores/use-user-store";
import type { Asset } from "@/stores/use-asset-store";

// Local object URLs are for this view only, never written back to the asset store.
export function useAssetMediaUrl(asset: Asset | null) {
    const token = useUserStore(state => state.token);
    const kind = asset?.kind;
    const storageKey = asset && asset.kind !== "text" ? asset.data.storageKey : undefined;
    const fallback = asset?.kind === "image" ? asset.data.dataUrl : asset && asset.kind !== "text" ? asset.data.url : "";
    const stableUrl = stableAssetUrl(storageKey, fallback);
    const [resolved, setResolved] = useState({ storageKey, url: stableUrl, token });
    useEffect(() => {
        let active = true;
        if (!storageKey || /^server:[A-Za-z0-9_-]+$/.test(storageKey)) return;
        const resolve = kind === "image" ? resolveImageUrl : resolveMediaUrl;
        void resolve(storageKey, stableUrl).then(url => {
            if (active && useUserStore.getState().token === token) setResolved({ storageKey, url, token });
        }).catch(() => {});
        return () => { active = false; };
    }, [kind, storageKey, stableUrl, token]);
    return resolved.storageKey === storageKey && resolved.token === token && !stableUrl ? resolved.url : stableUrl;
}
