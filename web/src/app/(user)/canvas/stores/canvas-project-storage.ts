import localforage from "localforage";
import { accountStorageKey, currentStorageOwnerId } from "@/lib/localforage-storage";
import type { CanvasProject } from "./use-canvas-store";
import { isCanvasProjectHydrated } from "../utils/canvas-project-hydration";

type CanvasState = { ownerUserId: string | null; projects: CanvasProject[]; conflictDrafts?: CanvasProject[] };
type CanvasValue = { state: CanvasState; version?: number };
type CanvasMeta = {
    format: 1;
    ownerUserId: string;
    projectIds: string[];
    conflictDraftIds: string[];
    version: number;
    writtenAt?: string;
    legacyImportedFingerprint?: string;
    deletedProjectIds?: string[];
    deletedConflictDraftIds?: string[];
};
type Snapshot = { project: CanvasProject; updatedAt: string };
const LEGACY_KEY = "infinite-canvas:canvas_store";
const metaKey = (owner: string) => `canvas_meta:${owner}`;
const projectKey = (owner: string, id: string) => `canvas_project:${owner}:${id}`;
const draftKey = (owner: string, id: string) => `canvas_conflict:${owner}:${id}`;
const deletedKey = (owner: string, id: string) => `canvas_deleted:${owner}:${id}`;
const hashText = (text: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${text.length}:${hash.toString(36)}`;
};


// localforage-storage.ts falls back to window.localStorage when IndexedDB is unavailable.
// The per-board keys must keep that guarantee, otherwise a quota/private-mode failure would
// leave the newest edits only in memory until the tab is closed.
const storedTimestamp = (raw: string | null): string => {
    if (!raw) return "";
    try {
        const value = JSON.parse(raw) as {
            updatedAt?: unknown;
            writtenAt?: unknown;
            deletedAt?: unknown;
            state?: { projects?: Array<{ updatedAt?: unknown }>; conflictDrafts?: Array<{ updatedAt?: unknown }> };
        };
        const timestamps: string[] = [];
        for (const candidate of [value.updatedAt, value.writtenAt, value.deletedAt]) {
            if (typeof candidate === "string") timestamps.push(candidate);
        }
        for (const item of [...(value.state?.projects || []), ...(value.state?.conflictDrafts || [])]) {
            if (typeof item.updatedAt === "string") timestamps.push(item.updatedAt);
        }
        return timestamps.sort().pop() || "";
    } catch { /* keep the primary value when neither side is parseable */ }
    return "";
};
const chooseStoredValue = (indexedDbValue: string | null, localStorageValue: string | null): string | null => {
    if (!indexedDbValue) return localStorageValue;
    if (!localStorageValue) return indexedDbValue;
    const indexedTimestamp = storedTimestamp(indexedDbValue);
    const localTimestamp = storedTimestamp(localStorageValue);
    if (localTimestamp && (!indexedTimestamp || localTimestamp > indexedTimestamp)) return localStorageValue;
    return indexedDbValue;
};
const readKey = async (key: string): Promise<string | null> => {
    let indexedDbValue: string | null = null;
    let localStorageValue: string | null = null;
    try { indexedDbValue = (await localforage.getItem<string>(key)) ?? null; } catch { /* fallback below */ }
    if (typeof window !== "undefined") {
        try { localStorageValue = window.localStorage.getItem(key); } catch { /* private mode may deny access */ }
    }
    return chooseStoredValue(indexedDbValue, localStorageValue);
};
const writeKey = async (key: string, value: string): Promise<void> => {
    try {
        await localforage.setItem(key, value);
    } catch (error) {
        if (typeof window === "undefined") throw error;
        window.localStorage.setItem(key, value);
    }
    };
const removeKey = async (key: string): Promise<void> => {
    let failure: unknown;
    try {
        await localforage.removeItem(key);
    } catch (error) {
        failure = error;
    }
    if (typeof window !== "undefined") {
        try { window.localStorage.removeItem(key); } catch (error) { failure ||= error; }
    }
    // If IndexedDB removal failed, do not report success just because the fallback copy was removed.
    // The caller must retain its retry/error path.
    if (failure) throw failure;
};
// The per-board records also recover an orphaned index entry on browsers without
// Web Locks. Deletion markers are independent records, so a stale meta cannot erase them.
const ownedDiskIds = async (prefix: string): Promise<string[]> => {
    const keys = new Set<string>();
    try { for (const key of await localforage.keys()) keys.add(key); } catch { /* fallback below */ }
    if (typeof window !== "undefined") {
        try {
            for (let index = 0; index < window.localStorage.length; index++) {
                const key = window.localStorage.key(index);
                if (key) keys.add(key);
            }
        } catch { /* IndexedDB may still be available */ }
    }
    return [...keys].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
};

// All calls are serialized by the canvas store's localSaveInFlight queue.
export function createCanvasProjectStorage(canWriteProject: (owner: string, id: string) => boolean = () => true) {
    let lastOwner: string | null = null;
    let projects = new Map<string, Snapshot>();
    let drafts = new Map<string, Snapshot>();
    let metadata: string | null = null;
    let legacyPending = false;
    let pendingLegacyFingerprint: string | undefined;
    const current = (owner: string) => owner === currentStorageOwnerId();
    const unique = (items: CanvasProject[]) => Array.from(new Map(items.map(project => [project.id, project])).values());
    const remember = (items: CanvasProject[]) => new Map(items.map(project => [project.id, { project, updatedAt: project.updatedAt }]));
    const reset = (owner: string) => {
        lastOwner = owner; projects = new Map(); drafts = new Map(); metadata = null; legacyPending = false; pendingLegacyFingerprint = undefined;
    };
    const removeLegacy = async (owner: string) => {
        if (!legacyPending || !current(owner)) return;
        const key = accountStorageKey(LEGACY_KEY, owner)!;
        await removeKey(key);
        if (!current(owner)) return;
        legacyPending = false;
    };

    // Keeps every complete board; on an id clash the newer `updatedAt` wins.
    const mergeNewer = (existing: CanvasProject[], incoming: CanvasProject[]): CanvasProject[] => {
        const byId = new Map(existing.map(item => [item.id, item]));
        for (const item of incoming) {
            if (!item || typeof item.id !== "string" || !item.id) continue;
            if (!isCanvasProjectHydrated(item)) continue;
            const previous = byId.get(item.id);
            if (!previous) { byId.set(item.id, item); continue; }
            if (String(item.updatedAt || "") > String(previous.updatedAt || "")) byId.set(item.id, item);
        }
        return Array.from(byId.values());
    };
    const sameItems = (left: CanvasProject[], right: CanvasProject[]) =>
        left.length === right.length && left.every((item, index) => item === right[index]);

    // A rollback to a pre-split build writes the whole package again; merge it instead of dropping it.
    const mergeLegacy = async (
        owner: string,
        loadedProjects: CanvasProject[],
        loadedDrafts: CanvasProject[],
        meta: CanvasMeta,
        prepare: (project: CanvasProject) => CanvasProject,
    ): Promise<CanvasValue | null> => {
        const legacy = await readKey(accountStorageKey(LEGACY_KEY, owner)!);
        if (!current(owner)) return null;
        const fallback: CanvasValue = { state: { ownerUserId: owner, projects: loadedProjects, conflictDrafts: loadedDrafts }, version: meta.version };
        if (!legacy) return fallback;
        let value: CanvasValue | null = null;
        try { value = legacy ? (JSON.parse(legacy) as CanvasValue) : null; } catch { value = null; }
        const state = value?.state;
        if (!state || state.ownerUserId !== owner) {
            // Never read or delete another account's package, and leave unreadable data on disk.
            legacyPending = false;
            return fallback;
        }
        const fingerprint = hashText(legacy);
        let currentMeta: CanvasMeta | null = null;
        try { currentMeta = metadata ? JSON.parse(metadata) as CanvasMeta : null; } catch { currentMeta = null; }
        if (currentMeta?.legacyImportedFingerprint === fingerprint) {
            try { await removeLegacy(owner); }
            catch (error) { console.warn("Canvas legacy cleanup deferred", error); }
            return fallback;
        }
        const mergedProjects = mergeNewer(loadedProjects, (state.projects || []).filter(project => !meta.deletedProjectIds?.includes(project.id)));
        const mergedDrafts = mergeNewer(loadedDrafts, (state.conflictDrafts || []).filter(project => !meta.deletedConflictDraftIds?.includes(project.id)));
        if (sameItems(mergedProjects, loadedProjects) && sameItems(mergedDrafts, loadedDrafts)) {
            // Nothing new: the package is a stale duplicate of what the index already holds.
            try { await removeLegacy(owner); }
            catch (error) { console.warn("Canvas legacy cleanup deferred", error); }
            return fallback;
        }
        const merged: CanvasValue = { state: { ownerUserId: owner, projects: mergedProjects, conflictDrafts: mergedDrafts }, version: value?.version ?? meta.version };
        pendingLegacyFingerprint = fingerprint;
        try { await write(merged, prepare); }
        catch (error) {
            console.warn("Canvas legacy merge deferred; retained legacy data", error);
            return fallback;
        }
        return current(owner) ? merged : null;
    };

    const writeUnlocked = async (value: CanvasValue, prepare: (project: CanvasProject) => CanvasProject) => {
        const { ownerUserId: owner } = value.state;
        if (!owner || !current(owner)) return;
        if (lastOwner !== owner) reset(owner);
        const rawMeta = await readKey(metaKey(owner));
        if (!current(owner)) return;
        const diskMeta = rawMeta ? JSON.parse(rawMeta) as CanvasMeta : null;
        if (diskMeta && (diskMeta.format !== 1 || diskMeta.ownerUserId !== owner)) throw new Error("画布本地索引无效");
        const diskDeletedIds = new Set(await ownedDiskIds(deletedKey(owner, "")));
        if (!current(owner)) return;
        const deletedIds = new Set([...(diskMeta?.deletedProjectIds || []), ...diskDeletedIds]);
        const deletedDraftIds = new Set(diskMeta?.deletedConflictDraftIds || []);
        const requestedIds = new Set(value.state.projects.map(project => project.id));
        const requestedDraftIds = new Set((value.state.conflictDrafts || []).map(project => project.id));
        // A later conflict for the same board is a new draft, not the old cleared one.
        for (const id of requestedDraftIds) if (!drafts.has(id)) deletedDraftIds.delete(id);
        // An omission is a deletion only if this instance previously knew that board.
        // Unknown ids in the latest disk index belong to another tab and must survive.
        for (const id of projects.keys()) if (!requestedIds.has(id)) deletedIds.add(id);
        for (const id of drafts.keys()) if (!requestedDraftIds.has(id)) deletedDraftIds.add(id);
        for (const id of deletedIds) {
            if (!current(owner)) return;
            if (!diskDeletedIds.has(id)) await writeKey(deletedKey(owner, id), JSON.stringify({ id, deletedAt: new Date().toISOString() }));
        }
        // A remote summary must neither overwrite nor delete a complete local copy.
        const nextProjects = unique(value.state.projects.flatMap(project => {
            if (deletedIds.has(project.id)) return [];
            if (isCanvasProjectHydrated(project)) return [project];
            const previous = projects.get(project.id)?.project;
            return previous && isCanvasProjectHydrated(previous) ? [previous] : [];
        }));
        const conflictDrafts = unique((value.state.conflictDrafts || []).filter(project => !deletedDraftIds.has(project.id) && isCanvasProjectHydrated(project)));
        const writeItems = async (items: CanvasProject[], previous: Map<string, Snapshot>, key: typeof projectKey) => {
            for (const project of items) {
                if (!current(owner)) return;
                const saved = previous.get(project.id);
                if (saved?.project === project && saved.updatedAt === project.updatedAt) continue;
                if (key === projectKey && !canWriteProject(owner, project.id)) {
                    // Keep the writer's copy, including saves queued before this tab lost its lease.
                    // A migration cannot commit its index or remove the legacy package without a copy.
                    if (!await readKey(key(owner, project.id))) return false;
                    continue;
                }
                await writeKey(key(owner, project.id), JSON.stringify(prepare(project)));
            }
            return true;
        };
        if (!await writeItems(nextProjects, projects, projectKey)) return;
        await writeItems(conflictDrafts, drafts, draftKey);
        if (!current(owner)) return;
        const diskProjectIds = await ownedDiskIds(projectKey(owner, ""));
        if (!current(owner)) return;
        const nextIds = new Set([...(diskMeta?.projectIds || []), ...diskProjectIds, ...nextProjects.map(project => project.id)].filter(id => !deletedIds.has(id)));
        const nextDraftIds = new Set([...(diskMeta?.conflictDraftIds || []), ...conflictDrafts.map(project => project.id)].filter(id => !deletedDraftIds.has(id)));
        let previousMeta: CanvasMeta | null = null;
        try { previousMeta = metadata ? JSON.parse(metadata) as CanvasMeta : null; } catch { previousMeta = null; }
        const sameIds = (left: string[], right: string[]) => left.length === right.length && left.every((id, index) => id === right[index]);
        const structureChanged = !sameIds(diskMeta?.projectIds || [], [...nextIds])
            || !sameIds(diskMeta?.conflictDraftIds || [], [...nextDraftIds])
            || (diskMeta?.deletedProjectIds?.length || 0) !== deletedIds.size
            || (diskMeta?.deletedConflictDraftIds?.length || 0) !== deletedDraftIds.size;
        const writtenAt = structureChanged || !diskMeta?.writtenAt ? new Date().toISOString() : diskMeta.writtenAt;
        const nextMeta = JSON.stringify({
            format: 1,
            ownerUserId: owner,
            projectIds: [...nextIds],
            conflictDraftIds: [...nextDraftIds],
            version: value.version ?? 0,
            writtenAt,
            legacyImportedFingerprint: pendingLegacyFingerprint || diskMeta?.legacyImportedFingerprint || previousMeta?.legacyImportedFingerprint,
            ...(deletedIds.size ? { deletedProjectIds: [...deletedIds] } : {}),
            ...(deletedDraftIds.size ? { deletedConflictDraftIds: [...deletedDraftIds] } : {}),
        } satisfies CanvasMeta);
        // Commit the index last: an interrupted migration must still read its complete legacy value.
        if (rawMeta !== nextMeta) await writeKey(metaKey(owner), nextMeta);
        for (const id of deletedIds) {
            if (!current(owner)) return;
            await removeKey(projectKey(owner, id));
        }
        for (const id of deletedDraftIds) {
            if (!current(owner)) return;
            await removeKey(draftKey(owner, id));
        }
        if (!current(owner)) return;
        // Remember what this tab observed, not the union: an unseen remote addition
        // omitted by its next save must never be mistaken for a local deletion.
        projects = remember(unique(value.state.projects.filter(isCanvasProjectHydrated)));
        drafts = remember(unique((value.state.conflictDrafts || []).filter(isCanvasProjectHydrated)));
        metadata = nextMeta;
        await removeLegacy(owner);
    };
    const write = async (value: CanvasValue, prepare: (project: CanvasProject) => CanvasProject) => {
        const owner = value.state.ownerUserId;
        if (!owner || !current(owner)) return;
        // Per-tab queues cannot serialize the shared account index across tabs.
        if (typeof navigator !== "undefined" && navigator.locks) {
            await navigator.locks.request(metaKey(owner), () => writeUnlocked(value, prepare));
        } else {
            await writeUnlocked(value, prepare);
        }
    };

    return {
        write,
        async read(owner: string, prepare: (project: CanvasProject) => CanvasProject): Promise<CanvasValue | null> {
            if (!current(owner)) return null;
            reset(owner);
            let readError: unknown;
            try {
                const rawMeta = await readKey(metaKey(owner));
                if (!current(owner)) return null;
                if (rawMeta) {
                    const meta = JSON.parse(rawMeta) as CanvasMeta;
                    if (meta.format !== 1 || meta.ownerUserId !== owner) throw new Error("画布本地索引无效");
                    const readItems = async (ids: string[], key: typeof projectKey) => {
                        const items: CanvasProject[] = [];
                        for (const id of ids) {
                            if (!current(owner)) return [];
                            const raw = await readKey(key(owner, id));
                            if (!raw) {
                                if (key === projectKey && await readKey(deletedKey(owner, id))) continue;
                                throw new Error("画布本地数据不完整，请重试");
                            }
                            const project = JSON.parse(raw) as CanvasProject;
                            if (project.id !== id || !isCanvasProjectHydrated(project)) throw new Error("画布本地数据无效");
                            items.push(project);
                        }
                        return items;
                    };
                    const deletedIds = new Set([...(meta.deletedProjectIds || []), ...await ownedDiskIds(deletedKey(owner, ""))]);
                    const projectIds = new Set([...meta.projectIds, ...await ownedDiskIds(projectKey(owner, ""))]);
                    if (!current(owner)) return null;
                    const loadedProjects = await readItems([...projectIds].filter(id => !deletedIds.has(id)), projectKey);
                    const conflictDrafts = await readItems(meta.conflictDraftIds.filter(id => !meta.deletedConflictDraftIds?.includes(id)), draftKey);
                    if (!current(owner)) return null;
                    projects = remember(loadedProjects); drafts = remember(conflictDrafts); metadata = rawMeta;
                    legacyPending = Boolean(await readKey(accountStorageKey(LEGACY_KEY, owner)!));
                    if (!current(owner)) return null;
                    if (legacyPending) return mergeLegacy(owner, loadedProjects, conflictDrafts, { ...meta, deletedProjectIds: [...deletedIds] }, prepare);
                    return { state: { ownerUserId: owner, projects: loadedProjects, conflictDrafts }, version: meta.version };
                }
            } catch (error) { readError = error; }
            if (!current(owner)) return null;
            const legacy = await readKey(accountStorageKey(LEGACY_KEY, owner)!);
            if (!current(owner)) return null;
            if (!legacy) { if (readError) throw readError; return null; }
            const value = JSON.parse(legacy) as CanvasValue;
            if (value.state.ownerUserId !== owner) return null;
            legacyPending = true;
            pendingLegacyFingerprint = hashText(legacy);
            try { await write(value, prepare); }
            catch (error) { console.warn("Canvas split migration deferred; retained legacy data", error); }
            return current(owner) ? value : null;
        },
        async remove(owner: string) {
            if (!current(owner)) return;
            // Clear the legacy package first. If this fails, leave the split index/data intact so a
            // refresh cannot fall back to an old package and resurrect deleted boards.
            await removeKey(accountStorageKey(LEGACY_KEY, owner)!);
            if (!current(owner)) return;
            const rawMeta = await readKey(metaKey(owner));
            if (!current(owner)) return;
            if (rawMeta) {
                const meta = JSON.parse(rawMeta) as CanvasMeta;
                if (meta.ownerUserId !== owner) return;
                for (const id of meta.projectIds) { if (!current(owner)) return; await removeKey(projectKey(owner, id)); }
                for (const id of meta.conflictDraftIds) { if (!current(owner)) return; await removeKey(draftKey(owner, id)); }
                if (!current(owner)) return;
                await removeKey(metaKey(owner));
            }
            reset(owner);
        },
    };
}
