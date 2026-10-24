import localforage from "localforage";
import { accountStorageKey, currentStorageOwnerId, localForageStorage } from "@/lib/localforage-storage";
import type { CanvasProject } from "./use-canvas-store";
import { isCanvasProjectHydrated } from "../utils/canvas-project-hydration";

type CanvasState = { ownerUserId: string | null; projects: CanvasProject[]; conflictDrafts?: CanvasProject[] };
type CanvasValue = { state: CanvasState; version?: number };
type CanvasMeta = { format: 1; ownerUserId: string; projectIds: string[]; conflictDraftIds: string[]; version: number };
type Snapshot = { project: CanvasProject; updatedAt: string };
const LEGACY_KEY = "infinite-canvas:canvas_store";
const metaKey = (owner: string) => `canvas_meta:${owner}`;
const projectKey = (owner: string, id: string) => `canvas_project:${owner}:${id}`;
const draftKey = (owner: string, id: string) => `canvas_conflict:${owner}:${id}`;

// All calls are serialized by the canvas store's localSaveInFlight queue.
export function createCanvasProjectStorage() {
    let lastOwner: string | null = null;
    let projects = new Map<string, Snapshot>();
    let drafts = new Map<string, Snapshot>();
    let metadata: string | null = null;
    let legacyPending = false;
    const current = (owner: string) => owner === currentStorageOwnerId();
    const unique = (items: CanvasProject[]) => Array.from(new Map(items.map(project => [project.id, project])).values());
    const remember = (items: CanvasProject[]) => new Map(items.map(project => [project.id, { project, updatedAt: project.updatedAt }]));
    const reset = (owner: string) => {
        lastOwner = owner; projects = new Map(); drafts = new Map(); metadata = null; legacyPending = false;
    };
    const removeLegacy = async (owner: string) => {
        if (!legacyPending || !current(owner)) return;
        const key = accountStorageKey(LEGACY_KEY, owner)!;
        await localforage.removeItem(key);
        if (!current(owner)) return;
        if (typeof window !== "undefined") window.localStorage.removeItem(key);
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
        const legacy = await localForageStorage.getItem(LEGACY_KEY);
        if (!current(owner)) return null;
        const fallback: CanvasValue = { state: { ownerUserId: owner, projects: loadedProjects, conflictDrafts: loadedDrafts }, version: meta.version };
        let value: CanvasValue | null = null;
        try { value = legacy ? (JSON.parse(legacy) as CanvasValue) : null; } catch { value = null; }
        const state = value?.state;
        if (!state || state.ownerUserId !== owner) {
            // Never read or delete another account's package, and leave unreadable data on disk.
            legacyPending = false;
            return fallback;
        }
        const mergedProjects = mergeNewer(loadedProjects, state.projects || []);
        const mergedDrafts = mergeNewer(loadedDrafts, state.conflictDrafts || []);
        if (sameItems(mergedProjects, loadedProjects) && sameItems(mergedDrafts, loadedDrafts)) {
            // Nothing new: the package is a stale duplicate of what the index already holds.
            try { await removeLegacy(owner); }
            catch (error) { console.warn("Canvas legacy cleanup deferred", error); }
            return fallback;
        }
        const merged: CanvasValue = { state: { ownerUserId: owner, projects: mergedProjects, conflictDrafts: mergedDrafts }, version: value?.version ?? meta.version };
        try { await write(merged, prepare); }
        catch (error) {
            console.warn("Canvas legacy merge deferred; retained legacy data", error);
            return fallback;
        }
        return current(owner) ? merged : null;
    };

    const write = async (value: CanvasValue, prepare: (project: CanvasProject) => CanvasProject) => {
        const { ownerUserId: owner } = value.state;
        if (!owner || !current(owner)) return;
        if (lastOwner !== owner) reset(owner);
        // A remote summary must neither overwrite nor delete a complete local copy.
        const nextProjects = unique(value.state.projects.flatMap(project => {
            if (isCanvasProjectHydrated(project)) return [project];
            const previous = projects.get(project.id)?.project;
            return previous && isCanvasProjectHydrated(previous) ? [previous] : [];
        }));
        const conflictDrafts = unique((value.state.conflictDrafts || []).filter(isCanvasProjectHydrated));
        const writeItems = async (items: CanvasProject[], previous: Map<string, Snapshot>, key: typeof projectKey) => {
            for (const project of items) {
                if (!current(owner)) return;
                const saved = previous.get(project.id);
                if (saved?.project === project && saved.updatedAt === project.updatedAt) continue;
                await localforage.setItem(key(owner, project.id), JSON.stringify(prepare(project)));
            }
        };
        await writeItems(nextProjects, projects, projectKey);
        await writeItems(conflictDrafts, drafts, draftKey);
        if (!current(owner)) return;
        const nextMeta = JSON.stringify({
            format: 1, ownerUserId: owner, projectIds: nextProjects.map(project => project.id),
            conflictDraftIds: conflictDrafts.map(project => project.id), version: value.version ?? 0,
        } satisfies CanvasMeta);
        // Commit the index last: an interrupted migration must still read its complete legacy value.
        if (metadata !== nextMeta) await localforage.setItem(metaKey(owner), nextMeta);
        if (!current(owner)) return;
        const nextIds = new Set(nextProjects.map(project => project.id));
        const nextDraftIds = new Set(conflictDrafts.map(project => project.id));
        for (const id of projects.keys()) {
            if (!current(owner)) return;
            if (!nextIds.has(id)) await localforage.removeItem(projectKey(owner, id));
        }
        for (const id of drafts.keys()) {
            if (!current(owner)) return;
            if (!nextDraftIds.has(id)) await localforage.removeItem(draftKey(owner, id));
        }
        if (!current(owner)) return;
        projects = remember(nextProjects); drafts = remember(conflictDrafts); metadata = nextMeta;
        await removeLegacy(owner);
    };

    return {
        write,
        async read(owner: string, prepare: (project: CanvasProject) => CanvasProject): Promise<CanvasValue | null> {
            if (!current(owner)) return null;
            reset(owner);
            let readError: unknown;
            try {
                const rawMeta = await localforage.getItem<string>(metaKey(owner));
                if (!current(owner)) return null;
                if (rawMeta) {
                    const meta = JSON.parse(rawMeta) as CanvasMeta;
                    if (meta.format !== 1 || meta.ownerUserId !== owner) throw new Error("画布本地索引无效");
                    const readItems = async (ids: string[], key: typeof projectKey) => {
                        const items: CanvasProject[] = [];
                        for (const id of ids) {
                            if (!current(owner)) return [];
                            const raw = await localforage.getItem<string>(key(owner, id));
                            if (!raw) throw new Error("画布本地数据不完整，请重试");
                            const project = JSON.parse(raw) as CanvasProject;
                            if (project.id !== id || !isCanvasProjectHydrated(project)) throw new Error("画布本地数据无效");
                            items.push(project);
                        }
                        return items;
                    };
                    const loadedProjects = await readItems(meta.projectIds, projectKey);
                    const conflictDrafts = await readItems(meta.conflictDraftIds, draftKey);
                    if (!current(owner)) return null;
                    projects = remember(loadedProjects); drafts = remember(conflictDrafts); metadata = rawMeta;
                    legacyPending = Boolean(await localForageStorage.getItem(LEGACY_KEY));
                    if (!current(owner)) return null;
                    if (legacyPending) return mergeLegacy(owner, loadedProjects, conflictDrafts, meta, prepare);
                    return { state: { ownerUserId: owner, projects: loadedProjects, conflictDrafts }, version: meta.version };
                }
            } catch (error) { readError = error; }
            if (!current(owner)) return null;
            const legacy = await localForageStorage.getItem(LEGACY_KEY);
            if (!current(owner)) return null;
            if (!legacy) { if (readError) throw readError; return null; }
            const value = JSON.parse(legacy) as CanvasValue;
            if (value.state.ownerUserId !== owner) return null;
            legacyPending = true;
            try { await write(value, prepare); }
            catch (error) { console.warn("Canvas split migration deferred; retained legacy data", error); }
            return current(owner) ? value : null;
        },
        async remove(owner: string) {
            if (!current(owner)) return;
            const rawMeta = await localforage.getItem<string>(metaKey(owner));
            if (!current(owner)) return;
            if (rawMeta) {
                const meta = JSON.parse(rawMeta) as CanvasMeta;
                if (meta.ownerUserId !== owner) return;
                for (const id of meta.projectIds) { if (!current(owner)) return; await localforage.removeItem(projectKey(owner, id)); }
                for (const id of meta.conflictDraftIds) { if (!current(owner)) return; await localforage.removeItem(draftKey(owner, id)); }
                if (!current(owner)) return;
                await localforage.removeItem(metaKey(owner));
            }
            if (!current(owner)) return;
            await localForageStorage.removeItem(LEGACY_KEY);
            reset(owner);
        },
    };
}
