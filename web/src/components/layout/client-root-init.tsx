"use client";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { App } from "antd";

import { fetchUserConfig } from "@/services/api/user-config";
import { normalizeImageOutputFormat } from "@/lib/image-output-format";
import { clearStorageConfigCache as clearImageStorageConfigCache, defaultUserStorageProvider, defaultUserWebDAVStorageProvider, saveUserStorageProvider, saveUserWebDAVStorageProvider, STORAGE_SYNC_COMPLETED_EVENT, STORAGE_SYNC_FAILED_EVENT } from "@/services/image-storage";
import { clearStorageConfigCache as clearFileStorageConfigCache } from "@/services/file-storage";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const handledConfigParams = useRef(false);
    const pathname = usePathname();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";
    const adminRemoteTokenRef = useRef("");
    const accountSessionRef = useRef({ token, userId: user?.id || "" });

    useEffect(() => {
        void loadPublicSettings();
    }, [loadPublicSettings]);

    useEffect(() => {
        clearImageStorageConfigCache();
        clearFileStorageConfigCache();
    }, [token]);

    useEffect(() => {
        const handleSyncFailure = (event: Event) => {
            const detail = event instanceof CustomEvent && typeof event.detail === "string" ? event.detail.trim() : "";
            message.open({ key: "storage-sync-failed", type: "warning", content: detail ? `云端同步失败，已保留原始素材：${detail}` : "云端同步失败，已保留原始素材" });
        };
        const handleSyncCompleted = (event: Event) => {
            const detail = event instanceof CustomEvent ? event.detail as { storageKey?: string; url?: string; ownerToken?: string } : null;
            if (!detail?.storageKey) return;
            const ownerToken = detail.ownerToken ?? useUserStore.getState().token;
            window.setTimeout(() => {
                void import("@/stores/use-asset-store").then(({ useAssetStore }) => {
                    const keys = new Map<string, string>([[detail.storageKey!, detail.storageKey!]]);
                    if (detail.url) keys.set(detail.url, detail.storageKey!);
                    useAssetStore.getState().cleanupImages(undefined, keys, ownerToken);
                });
            }, 2000);
        };
        window.addEventListener(STORAGE_SYNC_FAILED_EVENT, handleSyncFailure);
        window.addEventListener(STORAGE_SYNC_COMPLETED_EVENT, handleSyncCompleted);
        return () => {
            window.removeEventListener(STORAGE_SYNC_FAILED_EVENT, handleSyncFailure);
            window.removeEventListener(STORAGE_SYNC_COMPLETED_EVENT, handleSyncCompleted);
        };
    }, [message]);

    useEffect(() => {
        if (!isLoginPage) void hydrateUser();
    }, [hydrateUser, isLoginPage]);

    useEffect(() => {
        if (!token || user?.role !== "admin" || adminRemoteTokenRef.current === token) return;
        adminRemoteTokenRef.current = token;
    }, [token, user?.role]);

    useLayoutEffect(() => {
        const previous = accountSessionRef.current;
        const userId = user?.id || "";
        if ((previous.token && !token) || (previous.userId && userId && previous.userId !== userId)) {
            useConfigStore.setState({ config: defaultConfig });
        }
        accountSessionRef.current = { token, userId };
    }, [token, user?.id]);

    useEffect(() => {
        if (!token || !user?.id) return;
        const accountToken = token;
        const accountId = user.id;
        let canceled = false;
        void fetchUserConfig(accountToken)
            .then((payload) => {
                if (canceled || useUserStore.getState().token !== accountToken || useUserStore.getState().user?.id !== accountId) return;
                const syncS3 = payload.modelConfig?.syncStorageConfig === true;
                const syncWebDAV = payload.modelConfig?.syncWebDAVStorageConfig === true;
                if (payload.modelConfig) {
                    Object.entries(payload.modelConfig)
                        .forEach(([key, value]) => updateConfig(key as keyof AiConfig, value as never));
                    updateConfig("imageOutputFormat", normalizeImageOutputFormat(payload.modelConfig.imageOutputFormat));
                }
                updateConfig("syncStorageConfig", syncS3);
                updateConfig("syncWebDAVStorageConfig", syncWebDAV);
                if (syncS3 && payload.storageProvider?.s3) {
                    saveUserStorageProvider({
                        ...defaultUserStorageProvider(),
                        ...payload.storageProvider.s3,
                        type: "s3",
                    });
                }
                if (syncWebDAV && payload.storageProvider?.webdav) {
                    saveUserWebDAVStorageProvider({
                        ...defaultUserWebDAVStorageProvider(),
                        ...payload.storageProvider.webdav,
                        type: "webdav",
                    });
                }
                clearImageStorageConfigCache();
                clearFileStorageConfigCache();
            })
            .catch(() => {});
        return () => {
            canceled = true;
        };
    }, [token, updateConfig, user?.id]);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        if (!publicSettings) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        if (!publicSettings.modelChannel.allowCustomChannel) {
            openConfigDialog(false);
            message.error("后台未允许用户自定义渠道，请联系管理员进行配置");
            return;
        }
        updateConfig("channelMode", "local");
        updateConfig("channelModeManuallySelected", true);
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
    }, [message, openConfigDialog, publicSettings, updateConfig]);

    return <>{children}</>;
}
