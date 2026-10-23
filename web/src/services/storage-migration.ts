import localforage from "localforage";
import { currentStorageOwnerId } from "@/lib/localforage-storage";
import { getImageBlob, resolveImageUrl, uploadImage } from "./image-storage";
import { getMediaBlob, resolveMediaUrl, uploadMediaBlob } from "./file-storage";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { listCanvasProjects, syncCanvasProjects } from "./api/canvas-tasks";
import {
    assertGuestCanvasImportSession,
    guestCanvasImportCandidates,
    importGuestCanvasProjects,
    readAnonymousCanvasProjects,
    rewriteGuestCanvasReferences,
    type GuestCanvasImportProgress,
    type GuestCanvasImportSession,
} from "@/lib/guest-canvas-import";
import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";

function guestImportSession(): GuestCanvasImportSession | null {
    const { user, token, isReady } = useUserStore.getState();
    const ownerId = currentStorageOwnerId();
    return isReady && token && user?.id && ownerId === user.id ? { ownerId, token } : null;
}

const guestImportCompletedKey = (ownerId: string) => `infinite-canvas:guest_canvas_import:${ownerId}`;

async function completedGuestProjectIds(session: GuestCanvasImportSession) {
    assertGuestCanvasImportSession(session, guestImportSession());
    const value = await localforage.getItem<string[]>(guestImportCompletedKey(session.ownerId));
    assertGuestCanvasImportSession(session, guestImportSession());
    return Array.isArray(value) ? value : [];
}

export async function loadGuestCanvasImportProjects(ownerId: string, token: string) {
    const session = { ownerId, token };
    assertGuestCanvasImportSession(session, guestImportSession());
    const projects = await readAnonymousCanvasProjects(async key => {
        try {
            return await localforage.getItem<string>(key);
        } catch {
            return typeof window === "undefined" ? null : window.localStorage.getItem(key);
        }
    });
    assertGuestCanvasImportSession(session, guestImportSession());
    const completed = await completedGuestProjectIds(session);
    const current = useCanvasStore.getState();
    const existing = current.ownerUserId === ownerId ? current.projects.map(project => project.id) : [];
    return guestCanvasImportCandidates(projects, [...completed, ...existing]);
}

export async function importAnonymousCanvasProjects(
    projects: CanvasProject[],
    ownerId: string,
    token: string,
    onProgress: (progress: GuestCanvasImportProgress) => void,
) {
    const session = { ownerId, token };
    const assertOwner = () => assertGuestCanvasImportSession(session, guestImportSession());
    assertOwner();
    const completed = new Set(await completedGuestProjectIds(session));
    const media = new Map<string, Promise<{ storageKey: string; url: string }>>();
    const resolve = (storageKey: string, reference: Record<string, unknown>) => {
        if (!media.has(storageKey)) media.set(storageKey, (async () => {
            assertOwner();
            let blob = await getImageBlob(storageKey) || await getMediaBlob(storageKey);
            assertOwner();
            if (!blob) {
                const image = storageKey.startsWith("image:") || String(reference.mimeType || "").startsWith("image/");
                const url = storageKey.startsWith("server:") && !storageKey.startsWith("server:webdav:")
                    ? `/api/files/${encodeURIComponent(storageKey.slice("server:".length))}/content`
                    : image ? await resolveImageUrl(storageKey) : await resolveMediaUrl(storageKey);
                assertOwner();
                if (!url) throw new Error("本地媒体不存在，已保留游客画布，可恢复素材后重试");
                const response = await fetch(url, { headers: url.startsWith("/api/files/") ? { Authorization: `Bearer ${token}` } : undefined });
                if (!response.ok) throw new Error(`媒体读取失败：${response.status}`);
                blob = await response.blob();
                assertOwner();
            }
            const mediaKind = String(reference.__mediaKind || "").trim().toLowerCase();
            const isImage = mediaKind === "image" || blob.type.startsWith("image/") || storageKey.startsWith("image:");
            const uploaded = isImage
                ? await uploadImage(blob, { token })
                : await uploadMediaBlob(blob, `guest-${storageKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`, token);
            assertOwner();
            if (!uploaded.storageKey.startsWith("server:") || uploaded.storageKey.startsWith("server:webdav:")) {
                throw new Error("账号云存储不可用，已保留游客画布，请检查存储配置后重试");
            }
            return { storageKey: uploaded.storageKey, url: `/api/files/${encodeURIComponent(uploaded.storageKey.slice("server:".length))}/content` };
        })());
        return media.get(storageKey)!;
    };
    return importGuestCanvasProjects(projects, session, {
        currentSession: guestImportSession,
        listProjects: () => listCanvasProjects(token),
        currentProjects: () => useCanvasStore.getState().ownerUserId === ownerId ? useCanvasStore.getState().projects : [],
        rewriteProject: project => rewriteGuestCanvasReferences(project, resolve),
        saveProject: async project => {
            assertOwner();
            const saved = await syncCanvasProjects(token, [project]);
            assertOwner();
            const canonical = saved.find(item => item.id === project.id);
            if (!canonical) throw new Error("服务端未确认导入画布，请重试");
            return canonical;
        },
        commitProject: project => useCanvasStore.getState().importAccountProjects([project], ownerId, token),
        markComplete: async ids => {
            assertOwner();
            ids.forEach(id => completed.add(id));
            await localforage.setItem(guestImportCompletedKey(ownerId), [...completed]);
            assertOwner();
        },
        onProgress,
    });
}

export async function checkLocalAssetsExist(): Promise<boolean> {
    const imageStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
    const mediaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });

    let found = false;
    try {
        await imageStore.iterate((_val, key) => {
            if (key.startsWith("image:")) {
                found = true;
                return true; // Stop iteration early
            }
        });
        if (found) return true;

        await mediaStore.iterate((_val, key) => {
            if (key.startsWith("file:") || key.startsWith("video:") || key.startsWith("asset-video:") || key.startsWith("asset-audio:")) {
                found = true;
                return true; // Stop iteration early
            }
        });
    } catch (e) {
        console.error("checkLocalAssetsExist error", e);
    }
    return found;
}

// 本地媒体补传统一由画布恢复和用户就绪后的 repairCanvasProjectMedia 承担。
// 这里不再保留未接线、会整体改写多类历史数据的 migrateLocalAssetsToCloud 死代码。
