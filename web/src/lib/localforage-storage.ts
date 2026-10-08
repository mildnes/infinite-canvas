import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";
import { useUserStore } from "@/stores/use-user-store";

const ACCOUNT_STORE_KEYS = new Set(["infinite-canvas:canvas_store", "infinite-canvas:asset_store"]);

export function currentStorageOwnerId(): string | null {
    const { token, user, isReady } = useUserStore.getState();
    if (!isReady) return null;
    return token ? user?.id || null : "anon";
}

export async function waitForStorageOwner() {
    if (!useUserStore.persist.hasHydrated()) {
        await new Promise<void>(resolve => {
            const unsubscribe = useUserStore.persist.onFinishHydration(() => { unsubscribe(); resolve(); });
            if (useUserStore.persist.hasHydrated()) { unsubscribe(); resolve(); }
        });
    }
    if (!useUserStore.getState().isReady) {
        await new Promise<void>(resolve => {
            const unsubscribe = useUserStore.subscribe(state => { if (state.isReady) { unsubscribe(); resolve(); } });
            if (useUserStore.getState().isReady) { unsubscribe(); resolve(); }
        });
    }
    return currentStorageOwnerId();
}

export function accountStorageKey(name: string, owner = currentStorageOwnerId()) {
    if (!ACCOUNT_STORE_KEYS.has(name)) return name;
    return owner ? name + ":" + owner : null;
}

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        const owner = ACCOUNT_STORE_KEYS.has(name) ? await waitForStorageOwner() : null;
        const key = accountStorageKey(name, owner);
        if (!key) return null;
        let value: string | null;
        try {
            value = (await localforage.getItem<string>(key)) || null;
        } catch {
            value = window.localStorage.getItem(key);
        }
        if (ACCOUNT_STORE_KEYS.has(name) && owner !== currentStorageOwnerId()) return null;
        return value;
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        const key = accountStorageKey(name);
        if (!key) return;
        if (ACCOUNT_STORE_KEYS.has(name)) {
            try {
                if (JSON.parse(value).state?.ownerUserId !== currentStorageOwnerId()) {
                    console.warn("Discarded stale account storage write", name);
                    return;
                }
            } catch { return; }
        }
        try {
            await localforage.setItem(key, value);
        } catch {
            if (key === accountStorageKey(name)) window.localStorage.setItem(key, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        const key = accountStorageKey(name);
        if (!key) return;
        try {
            await localforage.removeItem(key);
        } catch {
            if (key === accountStorageKey(name)) window.localStorage.removeItem(key);
        }
    },
};
