import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";
import { useUserStore } from "@/stores/use-user-store";

const ACCOUNT_STORE_KEYS = new Set(["infinite-canvas:canvas_store", "infinite-canvas:asset_store"]);

export function currentStorageOwnerId(): string | null {
    const { token, user, isReady } = useUserStore.getState();
    if (user?.id) return user.id;
    if (!isReady) return null;
    return token ? null : "anon";
}

export async function waitForStorageOwner(timeoutMs = 12000) {
    const wait = (subscribe: (ready: () => void) => () => void, ready: () => boolean) => new Promise<void>((resolve, reject) => {
        let unsubscribe = () => {};
        const timeout = setTimeout(() => { unsubscribe(); reject(new Error("账号信息加载超时，请检查网络后重试")); }, timeoutMs);
        const finish = () => { if (ready()) { clearTimeout(timeout); unsubscribe(); resolve(); } };
        unsubscribe = subscribe(finish);
        finish();
    });
    const startedAt = Date.now();
    if (!useUserStore.persist.hasHydrated()) {
        await wait(resolve => useUserStore.persist.onFinishHydration(resolve), () => useUserStore.persist.hasHydrated());
    }
    if (!useUserStore.getState().isReady) {
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) throw new Error("账号信息加载超时，请检查网络后重试");
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { unsubscribe(); reject(new Error("账号信息加载超时，请检查网络后重试")); }, remaining);
            const finish = () => { if (useUserStore.getState().isReady) { clearTimeout(timeout); unsubscribe(); resolve(); } };
            const unsubscribe = useUserStore.subscribe(finish);
            finish();
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
