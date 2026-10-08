"use client";

import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { cleanupUnusedImages } from "@/services/image-storage";
import { cleanupUnusedMedia } from "@/services/file-storage";
import { mergeAssetSnapshots, type AssetSnapshot, type AssetTombstone } from "@/lib/asset-data";
import { prepareAssetForSave } from "@/services/asset-storage";
import { fetchUserAssetData, syncUserAssetData } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";

export type AssetKind = "text" | "image" | "video" | "audio";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type AudioAsset = AssetBase<"audio"> & { data: { url: string; storageKey?: string; bytes?: number; mimeType: string; durationMs?: number } };
export type Asset = TextAsset | ImageAsset | VideoAsset | AudioAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    category?: string;
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    assets: Asset[];
    tombstones: AssetTombstone[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => Promise<string>;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => Promise<void>;
    removeAsset: (id: string) => void;
    hydrateAccountAssets: (token: string, syncEnabled?: boolean) => Promise<void>;
    syncAccountAssets: (token: string) => Promise<void>;
    stopAccountAssetSync: () => void;
    cleanupImages: (extra?: unknown, storageKeys?: ReadonlyMap<string, string>, ownerToken?: string) => void;
};

const ASSET_STORE_KEY = "infinite-canvas:asset_store";
let activeAssetSyncToken = "";
let accountAssetSyncEnabled = false;
let isHydratingAccountAssets = false;
let syncTimer: number | null = null;
let syncSession = 0;
let syncInFlight: Promise<void> | null = null;

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const ownerToken = useUserStore.getState().token;
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        // Preserve the existing legacy inline-image migration, without reviving old blob URLs.
        parsed.state.assets = await Promise.all((parsed.state.assets || []).map(async asset => {
            if (asset.kind !== "image" || asset.data.storageKey || !asset.data.dataUrl?.startsWith("data:image/")) return asset;
            try { return await prepareAssetForSave(asset); } catch { return asset; }
        }));
        if (useUserStore.getState().token !== ownerToken) return null;
        Object.assign(parsed.state, mergeAssetSnapshots(parsed.state));
        return parsed;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify({ ...value, state: mergeAssetSnapshots(value.state) })),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            assets: [],
            tombstones: [],
            addAsset: async (asset) => {
                const ownerToken = useUserStore.getState().token;
                const now = new Date().toISOString();
                const id = nanoid();
                const prepared = await prepareAssetForSave({ ...asset, id, createdAt: now, updatedAt: now } as Asset);
                if (useUserStore.getState().token !== ownerToken) throw new Error("登录状态已变化，请重新保存素材");
                set((state) => mergeAssetSnapshots(state, { assets: [prepared] }));
                scheduleAssetSync(get);
                return id;
            },
            updateAsset: async (id, patch) => {
                const current = get().assets.find(asset => asset.id === id);
                if (!current) return;
                const ownerToken = useUserStore.getState().token;
                const prepared = await prepareAssetForSave({ ...current, ...patch, updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1 || 0)).toISOString() } as Asset);
                if (useUserStore.getState().token !== ownerToken) throw new Error("登录状态已变化，请重新保存素材");
                if (get().assets.find(asset => asset.id === id)?.updatedAt !== current.updatedAt) throw new Error("素材已变更，请重新打开后保存");
                set(state => mergeAssetSnapshots({ ...state, assets: state.assets.filter(asset => asset.id !== id) }, { assets: [prepared] }));
                scheduleAssetSync(get);
            },
            removeAsset: (id) =>
                set((state) => {
                    const deletedAsset = state.assets.find((asset) => asset.id === id);
                    const assets = state.assets.filter((asset) => asset.id !== id);

                    if (deletedAsset && deletedAsset.kind !== "text" && deletedAsset.data.storageKey) {
                        const key = deletedAsset.data.storageKey;
                        window.setTimeout(async () => {
                            const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
                            const usedKeys = new Set<string>();
                            // 收集其余资产的 storageKey
                            assets.forEach((a) => {
                                if (a.kind !== "text" && a.data.storageKey) usedKeys.add(a.data.storageKey);
                            });
                            // 收集画布中引用的 storageKey
                            const projects = useCanvasStore.getState().projects;
                            const { collectImageStorageKeys } = await import("@/services/image-storage");
                            const { collectMediaStorageKeys } = await import("@/services/file-storage");
                            collectImageStorageKeys(projects, usedKeys);
                            collectMediaStorageKeys(projects, usedKeys);

                            // 收集本地/云端生图历史与视频历史中的 storageKey，避免生成结果卡片失效
                            try {
                                const localforage = (await import("localforage")).default;
                                const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
                                await imageLogStore.iterate((log: any) => {
                                    if (log) {
                                        if (Array.isArray(log.images)) {
                                            log.images.forEach((img: any) => {
                                                if (img && img.storageKey) usedKeys.add(img.storageKey);
                                            });
                                        }
                                        if (Array.isArray(log.references)) {
                                            log.references.forEach((ref: any) => {
                                                if (ref && ref.storageKey) usedKeys.add(ref.storageKey);
                                            });
                                        }
                                    }
                                });
                            } catch (e) {
                                console.error("Error iterating image_generation_logs", e);
                            }

                            try {
                                const localforage = (await import("localforage")).default;
                                const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
                                await videoLogStore.iterate((log: any) => {
                                    if (log) {
                                        if (log.video && log.video.storageKey) {
                                            usedKeys.add(log.video.storageKey);
                                        }
                                        if (Array.isArray(log.references)) {
                                            log.references.forEach((ref: any) => {
                                                if (ref && ref.storageKey) usedKeys.add(ref.storageKey);
                                            });
                                        }
                                    }
                                });
                            } catch (e) {
                                console.error("Error iterating video_generation_logs", e);
                            }

                            // 若全站没有其他地方再引用此 storageKey，则执行真正的物理删除
                            if (!usedKeys.has(key)) {
                                if (key.startsWith("image:") || key.startsWith("server:")) {
                                    const { deleteStoredImages } = await import("@/services/image-storage");
                                    await deleteStoredImages([key]);
                                }
                                if (key.startsWith("file:") || key.startsWith("video:") || key.startsWith("server:")) {
                                    const { deleteStoredMedia } = await import("@/services/file-storage");
                                    await deleteStoredMedia([key]);
                                }
                            }
                        }, 0);
                    }

                    window.setTimeout(() => scheduleAssetSync(get), 0);
                    const deletedAt = new Date(Math.max(Date.now(), Date.parse(deletedAsset?.updatedAt || "") + 1 || 0)).toISOString();
                    return mergeAssetSnapshots({ ...state, assets }, { assets: [], tombstones: [{ id, deletedAt }] });
                }),
            hydrateAccountAssets: async (token, syncEnabled = false) => {
                if (!token) return;
                activeAssetSyncToken = token;
                accountAssetSyncEnabled = syncEnabled;
                const session = ++syncSession;
                syncInFlight = null;
                isHydratingAccountAssets = true;
                try {
                    const remote = await fetchUserAssetData<AssetSnapshot>(token);
                    if (!isCurrentAssetSession(token, session)) return;
                    set(mergeAssetSnapshots(remote, get()));
                } finally {
                    if (isCurrentAssetSession(token, session)) {
                        isHydratingAccountAssets = false;
                        scheduleAssetSync(get);
                    }
                }
            },
            syncAccountAssets: async (token) => {
                const session = syncSession;
                if (!isCurrentAssetSession(token, session) || !accountAssetSyncEnabled || isHydratingAccountAssets) return;
                if (syncInFlight) return syncInFlight;
                const run = async () => {
                    for (let attempt = 0; attempt < 5; attempt++) {
                        const remote = await fetchUserAssetData<AssetSnapshot>(token);
                        if (!isCurrentAssetSession(token, session)) return;
                        const merged = mergeAssetSnapshots(remote, get());
                        try {
                            const saved = await syncUserAssetData(token, merged, remote?.revision);
                            if (!isCurrentAssetSession(token, session)) return;
                            const settled = mergeAssetSnapshots(saved, get());
                            set(settled);
                            if (JSON.stringify(settled) === JSON.stringify(merged)) return;
                        } catch (error) {
                            if (!isCurrentAssetSession(token, session)) return;
                            if ((error as { status?: number }).status !== 409) throw error;
                        }
                    }
                    throw new Error("素材同步发生冲突，将保留本地修改并稍后重试");
                };
                const pending = run();
                syncInFlight = pending;
                try { await pending; } finally { if (syncInFlight === pending) syncInFlight = null; }
            },
            stopAccountAssetSync: () => {
                activeAssetSyncToken = "";
                ++syncSession;
                syncInFlight = null;
                accountAssetSyncEnabled = false;
                isHydratingAccountAssets = false;
                if (syncTimer) window.clearTimeout(syncTimer);
                syncTimer = null;
            },
            cleanupImages: (extra, storageKeys, ownerToken) => {
                const cleanupOwnerToken = ownerToken === undefined ? useUserStore.getState().token : ownerToken;
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
                    const { useAgentSkillStore } = await import("@/stores/use-agent-skill-store");
                    const logKeys: string[] = [];
                    try {
                        const localforage = (await import("localforage")).default;
                        const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
                        await imageLogStore.iterate((log: any) => {
                            if (log) {
                                if (Array.isArray(log.images)) {
                                    log.images.forEach((img: any) => {
                                        if (img && img.storageKey) logKeys.push(img.storageKey);
                                    });
                                }
                                if (Array.isArray(log.references)) {
                                    log.references.forEach((ref: any) => {
                                        if (ref && ref.storageKey) logKeys.push(ref.storageKey);
                                    });
                                }
                            }
                        });
                        const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
                        await videoLogStore.iterate((log: any) => {
                            if (log) {
                                if (log.video && log.video.storageKey) {
                                    logKeys.push(log.video.storageKey);
                                }
                                if (Array.isArray(log.references)) {
                                    log.references.forEach((ref: any) => {
                                        if (ref && ref.storageKey) logKeys.push(ref.storageKey);
                                    });
                                }
                            }
                        });
                    } catch (e) {
                        console.error("Error gathering log keys in cleanupImages", e);
                    }

                    try {
                        await useAgentSkillStore.getState().loadSkills();
                        const skillStore = useAgentSkillStore.getState();
                        const skills = [...skillStore.systemSkills, ...skillStore.userSkills];
                        const cleanupData = { assets: get().assets, projects: useCanvasStore.getState().projects, skills, extra, logKeys };
                        await cleanupUnusedImages(cleanupData, storageKeys, cleanupOwnerToken);
                        // Cloud keys are provider-agnostic and are deleted by the
                        // first pass. The media pass still sweeps local video/audio
                        // stores, but must not issue a duplicate cloud DELETE.
                        await cleanupUnusedMedia(cleanupData, new Map(), cleanupOwnerToken);
                    } catch (error) {
                        console.error("Error gathering Skill keys in cleanupImages", error);
                    }
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => mergeAssetSnapshots(state) as StorageValue<AssetStore>["state"],
        },
    ),
);

function isCurrentAssetSession(token: string, session: number) {
    return Boolean(token) && token === activeAssetSyncToken && session === syncSession && useUserStore.getState().token === token;
}

function scheduleAssetSync(get: () => AssetStore, delay = 600) {
    if (isHydratingAccountAssets || !activeAssetSyncToken || !accountAssetSyncEnabled || typeof window === "undefined") return;
    if (syncTimer) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
        const token = activeAssetSyncToken;
        const session = syncSession;
        void get().syncAccountAssets(token).catch(() => {
            if (isCurrentAssetSession(token, session)) scheduleAssetSync(get, 30_000);
        });
    }, delay);
}

export { mergeAssets } from "@/lib/asset-data";
