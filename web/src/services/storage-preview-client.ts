import { prepareImagePreview } from "@/lib/image-preview";
import { uploadStoragePreview } from "@/services/api/storage";
import { useUserStore } from "@/stores/use-user-store";

const submitted = new Set<string>();

// Cache failure must not alter successful media, cloud uploads or node state.
export function publishStoragePreview(storageKey: string, prepared: ReturnType<typeof prepareImagePreview>, ownerToken: string) {
    const id = storageKey.match(/^server:([A-Za-z0-9_-]+)$/)?.[1];
    if (!id || !ownerToken) return;
    void (async () => {
        const blob = await prepared;
        const key = `${ownerToken}:${id}`;
        if (!blob || useUserStore.getState().token !== ownerToken || submitted.has(key)) return;
        submitted.add(key);
        if (submitted.size > 256) submitted.delete(submitted.values().next().value!);
        try { await uploadStoragePreview(ownerToken, id, blob, AbortSignal.timeout(10_000)); } catch { submitted.delete(key); }
    })();
}

export { prepareImagePreview };
