import { prepareImagePreview, type ImagePreviewSourceSize } from "@/lib/image-preview";
import { uploadStoragePreview } from "@/services/api/storage";
import { useUserStore } from "@/stores/use-user-store";

const submitted = new Set<string>();
const backfillAttempted = new Set<string>();
let activeBackfills = 0;
const waitingBackfills: (() => Promise<void>)[] = [];

function runBackfill(task: () => Promise<void>) {
    activeBackfills++;
    void task().catch(() => undefined).finally(() => {
        activeBackfills--;
        const next = waitingBackfills.shift();
        if (next) runBackfill(next);
    });
}

// Cache failure must not alter successful media, cloud uploads or node state.
export async function publishStoragePreview(storageKey: string, prepared: ReturnType<typeof prepareImagePreview>, ownerToken: string) {
    const id = storageKey.match(/^server:([A-Za-z0-9_-]+)$/)?.[1];
    if (!id || !ownerToken) return;
    const key = `${ownerToken}:${id}`;
    let reserved = false;
    try {
        const blob = await prepared;
        if (!blob || useUserStore.getState().token !== ownerToken || submitted.has(key)) return;
        submitted.add(key);
        reserved = true;
        if (submitted.size > 256) submitted.delete(submitted.values().next().value!);
        await uploadStoragePreview(ownerToken, id, blob, AbortSignal.timeout(10_000));
    } catch { if (reserved) submitted.delete(key); }
}

// A missing preview is a display-cache miss, never a reason to change node data.
// Cache-only reads never re-download an original; at most two jobs hold cached bytes.
export function backfillStoragePreviewFromOriginal(originalUrl: string, storageKey: string | undefined, ownerToken: string, sourceSize: ImagePreviewSourceSize) {
    const id = storageKey?.match(/^server:([A-Za-z0-9_-]+)$/)?.[1];
    if (!id || !ownerToken || !originalUrl || useUserStore.getState().token !== ownerToken) return;
    if (!sourceSize || !Number.isFinite(sourceSize.width) || !Number.isFinite(sourceSize.height) || sourceSize.width <= 0 || sourceSize.height <= 0) return;
    const key = `${ownerToken}:${id}`;
    if (backfillAttempted.has(key)) return;
    backfillAttempted.add(key);
    if (waitingBackfills.length >= 64) return;
    const task = async () => {
        if (useUserStore.getState().token !== ownerToken) return;
        const response = await fetch(originalUrl, { cache: "only-if-cached", mode: "same-origin", signal: AbortSignal.timeout(10_000) });
        if (!response.ok || useUserStore.getState().token !== ownerToken) return;
        const blob = await response.blob();
        if (useUserStore.getState().token !== ownerToken) return;
        await publishStoragePreview(storageKey!, prepareImagePreview(blob, sourceSize), ownerToken);
    };
    if (activeBackfills < 2) runBackfill(task);
    else waitingBackfills.push(task);
}

export { prepareImagePreview };
