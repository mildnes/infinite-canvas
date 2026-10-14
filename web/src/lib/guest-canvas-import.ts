import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";

export const ANONYMOUS_CANVAS_STORE_KEY = "infinite-canvas:canvas_store:anon";

export type GuestCanvasImportSession = { ownerId: string; token: string };
export type GuestCanvasImportProgress = {
    total: number;
    completed: number;
    imported: number;
    skipped: number;
    failed: number;
    errors: { id: string; title: string; message: string }[];
};

export async function readAnonymousCanvasProjects(read: (key: string) => Promise<string | null>) {
    const value = await read(ANONYMOUS_CANVAS_STORE_KEY);
    if (!value) return [];
    const state = (JSON.parse(value) as { state?: { ownerUserId?: string; projects?: CanvasProject[] } }).state;
    return state?.ownerUserId === "anon" && Array.isArray(state.projects) ? state.projects : [];
}

export function guestCanvasImportCandidates(projects: CanvasProject[], existingIds: Iterable<string> = []) {
    const seen = new Set(existingIds);
    return projects.filter(project => {
        if (!project.id || seen.has(project.id)) return false;
        seen.add(project.id);
        return true;
    });
}

export function assertGuestCanvasImportSession(expected: GuestCanvasImportSession, current: GuestCanvasImportSession | null) {
    if (!current || current.ownerId !== expected.ownerId || current.token !== expected.token) {
        throw new Error("登录状态已变化，请在当前账号重新导入");
    }
}

/** The storage key is authoritative even if a stale blob/data/HTTP URL is present. */
export async function rewriteGuestCanvasReferences<T>(
    source: T,
    resolve: (storageKey: string, reference: Record<string, unknown>) => Promise<{ storageKey: string; url: string }>,
): Promise<T> {
    const resolved = new Map<string, Promise<{ storageKey: string; url: string }>>();
    const walk = async (value: unknown, media = false, mediaKind = ""): Promise<unknown> => {
        if (Array.isArray(value)) {
            const items = [];
            for (const item of value) items.push(await walk(item, media, mediaKind));
            return items;
        }
        if (!value || typeof value !== "object") return value;
        const record = value as Record<string, unknown>;
        const next: Record<string, unknown> = {};
        const mediaNode = ["image", "panorama", "video", "audio"].includes(String(record.type || ""));
        const nodeMediaKind = mediaNode ? (record.type === "video" ? "video" : record.type === "audio" ? "audio" : "image") : mediaKind;
        for (const [key, item] of Object.entries(record)) next[key] = await walk(item, key === "metadata" && mediaNode ? true : media, key === "metadata" && mediaNode ? nodeMediaKind : mediaKind);
        const storageKey = typeof record.storageKey === "string" ? record.storageKey.trim() : "";
        if (!storageKey) {
            if ((media || "dataUrl" in record || "imageUrl" in record) && [record.content, record.dataUrl, record.originalUrl, record.imageUrl].some(item => typeof item === "string" && /^(blob:|data:)/.test(item.trim()))) {
                throw new Error("媒体缺少可恢复的存储引用，已保留游客原件，请恢复素材后重试");
            }
            return next;
        }
        const reference = mediaKind ? { ...record, __mediaKind: mediaKind } : record;
        if (!resolved.has(storageKey)) resolved.set(storageKey, resolve(storageKey, reference));
        const ref = await resolved.get(storageKey)!;
        if (!ref.storageKey.startsWith("server:") || ref.storageKey.startsWith("server:webdav:") || !ref.url.startsWith("/api/files/")) {
            throw new Error("媒体尚未持久化到账号，请检查存储配置后重试");
        }
        next.storageKey = ref.storageKey;
        const fields = ["content", "dataUrl", "originalUrl", "url", "imageUrl"];
        for (const field of fields) if (field in record) next[field] = ref.url;
        if (!fields.some(field => field in record)) next.content = ref.url;
        if ("mediaStatus" in record) next.mediaStatus = "ok";
        if ("mediaError" in record) next.mediaError = undefined;
        return next;
    };
    return await walk(source) as T;
}

type GuestCanvasImportDependencies = {
    currentSession: () => GuestCanvasImportSession | null;
    listProjects: () => Promise<CanvasProject[]>;
    currentProjects: () => CanvasProject[];
    rewriteProject: (project: CanvasProject) => Promise<CanvasProject>;
    saveProject: (project: CanvasProject) => Promise<CanvasProject>;
    commitProject: (project: CanvasProject) => Promise<void>;
    markComplete: (ids: string[]) => Promise<void>;
    onProgress: (progress: GuestCanvasImportProgress) => void;
};

export async function importGuestCanvasProjects(
    source: CanvasProject[],
    session: GuestCanvasImportSession,
    deps: GuestCanvasImportDependencies,
) {
    const assertOwner = () => assertGuestCanvasImportSession(session, deps.currentSession());
    assertOwner();
    const remote = await deps.listProjects();
    assertOwner();
    const existing = new Set([...remote, ...deps.currentProjects()].map(project => project.id));
    const projects = guestCanvasImportCandidates(source);
    const progress: GuestCanvasImportProgress = { total: projects.length, completed: 0, imported: 0, skipped: 0, failed: 0, errors: [] };
    const report = () => deps.onProgress({ ...progress, errors: [...progress.errors] });
    report();
    for (const project of projects) {
        assertOwner();
        try {
            if (existing.has(project.id)) {
                await deps.markComplete([project.id]);
                assertOwner();
                progress.skipped++;
            } else {
                const rewritten = await deps.rewriteProject(project);
                assertOwner();
                const saved = await deps.saveProject(rewritten);
                assertOwner();
                await deps.commitProject(saved);
                assertOwner();
                await deps.markComplete([project.id]);
                assertOwner();
                existing.add(project.id);
                progress.imported++;
            }
        } catch (error) {
            assertOwner();
            progress.failed++;
            progress.errors.push({ id: project.id, title: project.title, message: error instanceof Error ? error.message : "导入失败，请重试" });
        }
        progress.completed++;
        report();
    }
    return progress;
}
