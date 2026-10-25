import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { currentStorageOwnerId, waitForStorageOwner } from "@/lib/localforage-storage";
import { deleteCanvasProjects, getCanvasProject, listCanvasProjects, saveCanvasProject, syncCanvasProjects } from "@/services/api/canvas-tasks";
import { fetchUserConfig } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAgentConfig, CanvasAssistantSession, CanvasConnection, CanvasNodeData, CanvasPendingAgentRequest, ViewportTransform } from "../types";
import { sanitizeCanvasNodesForPersistence, sanitizeCanvasSessionsForPersistence } from "../utils/canvas-media-persistence";
import { createCanvasProjectStorage } from "./canvas-project-storage";
import { isCanvasProjectEditable, isCanvasProjectHydrated, type CanvasProjectSummary } from "../utils/canvas-project-hydration";

export type CanvasSidePanelState = {
    open: boolean;
    width: number;
};

export const DEFAULT_CANVAS_SIDE_PANEL: CanvasSidePanelState = { open: true, width: 280 };
export const DEFAULT_CANVAS_AGENT_PANEL: CanvasSidePanelState = { open: false, width: 390 };

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    serverUpdatedAt?: string;
    pendingSave?: boolean;
    hydrated?: boolean;
    nodeCount?: number;
    connectionCount?: number;
    sessionCount?: number;
    remoteUpdatedAt?: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    agentConfig: CanvasAgentConfig | null;
    autoTitlePending: boolean;
    pendingAgentRequest?: CanvasPendingAgentRequest;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    showConnections: boolean;
    snapToGrid: boolean;
    viewport: ViewportTransform;
    sidePanel: CanvasSidePanelState;
    agentPanel: CanvasSidePanelState;
};

type CanvasStore = {
    ownerUserId: string | null;
    hydrated: boolean;
    projects: CanvasProject[];
    syncError: string | null;
    conflictDrafts: CanvasProject[];
    restoreVersion: number;
    createProject: (title?: string, options?: { agentConfig?: CanvasAgentConfig; pendingAgentRequest?: CanvasPendingAgentRequest }) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    loadProject: (id: string) => Promise<CanvasProject | null>;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => Promise<void>;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "agentConfig" | "autoTitlePending" | "backgroundMode" | "showImageInfo" | "showConnections" | "snapToGrid" | "viewport" | "sidePanel" | "agentPanel" | "pendingAgentRequest">>) => void;
    syncWithRemote: (token: string, syncEnabled: boolean) => Promise<void>;
    setSyncEnabled: (enabled: boolean) => void;
    retrySaves: () => Promise<void>;
    importAccountProjects: (projects: CanvasProject[], expectedOwner: string, expectedToken: string) => Promise<void>;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects" | "ownerUserId"> & Partial<Pick<CanvasStore, "conflictDrafts">>;
let lastOwnerId: string | null = null;
let ownerEpoch = 0;
let ownerLoading = true;
let hydrationFailed = false;
let ownerHydration: Promise<void> | undefined;
let hydrationAttempt = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveMaxTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let queuedPersistValue: { name: string; value: StorageValue<CanvasStore> } | null = null;
let localSaveInFlight = Promise.resolve();
let accountCanvasSyncEnabled = false;
const projectSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const projectMaxTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingProjectSaves = new Map<string, CanvasProject>();
const projectSavesInFlight = new Map<string, Promise<void>>();
const projectLoadsInFlight = new Map<string, Promise<CanvasProject | null>>();
const failedProjectSaves = new Set<string>();
const remoteDeletedProjectIds = new Set<string>();
const deletingProjectIds = new Set<string>();
const MAX_SAVE_WAIT_MS = 2000;
const sanitizedNodes = new WeakMap<CanvasNodeData[], CanvasNodeData[]>();
const sanitizedSessions = new WeakMap<CanvasAssistantSession[], CanvasAssistantSession[]>();
// Only an explicit retry may resolve the exact draft it restored.
const retryDrafts = new WeakMap<CanvasProject, CanvasProject>();
const projectStorage = createCanvasProjectStorage();

function persistentProject(project: CanvasProject): CanvasProject {
    let nodes = sanitizedNodes.get(project.nodes);
    if (!nodes) { nodes = sanitizeCanvasNodesForPersistence(project.nodes); sanitizedNodes.set(project.nodes, nodes); }
    const sessions = project.chatSessions || [];
    let chatSessions = sanitizedSessions.get(sessions);
    if (!chatSessions) { chatSessions = sanitizeCanvasSessionsForPersistence(sessions); sanitizedSessions.set(sessions, chatSessions); }
    return { ...project, nodes, chatSessions };
}

function flushLocalCanvasSave() {
    if (saveTimer) clearTimeout(saveTimer);
    if (saveMaxTimer) clearTimeout(saveMaxTimer);
    saveTimer = saveMaxTimer = null;
    const pending = queuedPersistValue;
    queuedPersistValue = null;
    if (pending) {
        localSaveInFlight = persistLocalCanvasValue(pending.value).catch((error) => {
            if (!queuedPersistValue && pending.value.state.ownerUserId === currentStorageOwnerId()) queuedPersistValue = pending;
            throw error;
        });
    }
    return localSaveInFlight;
}

function persistLocalCanvasValue(value: StorageValue<CanvasStore>) {
    localSaveInFlight = localSaveInFlight.catch(() => undefined).then(() => projectStorage.write(value, persistentProject));
    return localSaveInFlight;
}

function canonicalProject(project: CanvasProject): CanvasProject {
    return { ...project, serverUpdatedAt: project.updatedAt, pendingSave: false };
}

function listedProject(project: CanvasProjectSummary | CanvasProject): CanvasProject {
    if (isCanvasProjectHydrated(project)) return project as CanvasProject;
    return {
        ...project, hydrated: false, nodes: [], connections: [], chatSessions: [],
        activeChatId: null, agentConfig: null, autoTitlePending: false,
        backgroundMode: "lines", showImageInfo: false, showConnections: true, snapToGrid: false,
        viewport: initialViewport, sidePanel: DEFAULT_CANVAS_SIDE_PANEL, agentPanel: DEFAULT_CANVAS_AGENT_PANEL,
    };
}

function recordSaveError(error: unknown, draft?: CanvasProject) {
    const conflict = error as { status?: number; data?: { currentProject?: CanvasProject } };
    const hasCanonicalProject = conflict.status === 409 && conflict.data && Object.prototype.hasOwnProperty.call(conflict.data, "currentProject");
    const current = hasCanonicalProject ? conflict.data?.currentProject : null;
    if (hasCanonicalProject && !current && draft) {
        remoteDeletedProjectIds.add(draft.id);
        failedProjectSaves.delete(draft.id);
    }
    useCanvasStore.setState((state) => ({
        syncError: hasCanonicalProject && !current ? "远端画布已删除，本机副本已保留，可另存为新画布" : error instanceof Error ? error.message : "画布同步失败，请重试",
        ...(current && draft ? {
            projects: state.projects.map((project) => project.id === current.id ? canonicalProject(current) : project),
            conflictDrafts: [...state.conflictDrafts.filter((project) => project.id !== draft.id), draft],
            restoreVersion: state.restoreVersion + 1,
        } : {}),
        ...(hasCanonicalProject && !current && draft ? {
            projects: state.projects.map((project) => project.id === draft.id ? { ...project, pendingSave: false } : project),
            conflictDrafts: [...state.conflictDrafts.filter((project) => project.id !== draft.id), { ...draft, pendingSave: false }],
            restoreVersion: state.restoreVersion + 1,
        } : {}),
    }));
}

async function flushProjectSave(id: string): Promise<void> {
    if (deletingProjectIds.has(id)) return;
    const previous = projectSavesInFlight.get(id);
    if (previous) { await previous; if (pendingProjectSaves.has(id)) return flushProjectSave(id); return; }
    const queued = pendingProjectSaves.get(id);
    if (!queued) return;
    cancelProjectSaves([id]);
    const project = useCanvasStore.getState().projects.find((item) => item.id === id) || queued;
    if (!isCanvasProjectHydrated(project)) return;
    const retryDraft = retryDrafts.get(project);
    if (useCanvasStore.getState().conflictDrafts.some((draft) => draft.id === id && draft !== retryDraft)) return;
    const owner = currentStorageOwnerId();
    const epoch = ownerEpoch;
    const token = useUserStore.getState().token;
    if (!owner || !token || !accountCanvasSyncEnabled || useCanvasStore.getState().ownerUserId !== owner) return;
    const current = () => epoch === ownerEpoch && currentStorageOwnerId() === owner;
    const request = (async () => {
        try {
            const saved = await saveCanvasProject(token, persistentProject(project), project.serverUpdatedAt ?? "");
            if (!current() || !saved) return;
            failedProjectSaves.delete(id);
            useCanvasStore.setState((state) => {
                const conflictDrafts = state.conflictDrafts.filter((draft) => draft !== retryDraft);
                return {
                    projects: state.projects.map((latest) => latest.id !== id ? latest : latest === project ? canonicalProject(saved) : { ...latest, serverUpdatedAt: saved.updatedAt }),
                    syncError: failedProjectSaves.size || conflictDrafts.length ? state.syncError : null,
                    conflictDrafts,
                };
            });
        } catch (error) {
            if (!current()) return;
            failedProjectSaves.add(id);
            recordSaveError(error, useCanvasStore.getState().projects.find((item) => item.id === id) || project);
        }
    })();
    projectSavesInFlight.set(id, request);
    try { await request; } finally {
        if (projectSavesInFlight.get(id) === request) projectSavesInFlight.delete(id);
        if (pendingProjectSaves.has(id)) void flushProjectSave(id);
    }
}

export async function flushCanvasSaves() {
    const local = flushLocalCanvasSave();
    await Promise.all([local, ...Array.from(pendingProjectSaves.keys(), flushProjectSave), ...projectSavesInFlight.values()]);
    await flushLocalCanvasSave();
}

function resetCanvasOwner(owner: string | null) {
    if (lastOwnerId === owner) return;
    lastOwnerId = owner;
    ownerEpoch++;
    ownerLoading = true;
    hydrationFailed = false;
    accountCanvasSyncEnabled = false;
    if (saveTimer) clearTimeout(saveTimer);
    if (saveMaxTimer) clearTimeout(saveMaxTimer);
    saveTimer = null;
    saveMaxTimer = null;
    queuedPersistState = null;
    queuedPersistValue = null;
    cancelProjectSaves([...projectSaveTimers.keys()]);
    failedProjectSaves.clear();
    remoteDeletedProjectIds.clear();
    deletingProjectIds.clear();
    projectSavesInFlight.clear();
    projectLoadsInFlight.clear();
    useCanvasStore.setState({ projects: [], conflictDrafts: [], syncError: null, ownerUserId: owner, hydrated: false });
}

function queueProjectSave(project: CanvasProject) {
    if (!isCanvasProjectHydrated(project)) return;
    if (deletingProjectIds.has(project.id)) return;
    const owner = currentStorageOwnerId();
    if (!owner || useCanvasStore.getState().ownerUserId !== owner) return;
    const previous = projectSaveTimers.get(project.id);
    if (previous) clearTimeout(previous);
    pendingProjectSaves.set(project.id, project);
    projectSaveTimers.set(project.id, setTimeout(() => { void flushProjectSave(project.id); }, 400));
    if (!projectMaxTimers.has(project.id)) projectMaxTimers.set(project.id, setTimeout(() => { void flushProjectSave(project.id); }, MAX_SAVE_WAIT_MS));
}

function cancelProjectSaves(ids: string[]) {
    ids.forEach((id) => {
        const timer = projectSaveTimers.get(id);
        if (timer) clearTimeout(timer);
        const maxTimer = projectMaxTimers.get(id);
        if (maxTimer) clearTimeout(maxTimer);
        projectSaveTimers.delete(id);
        projectMaxTimers.delete(id);
        pendingProjectSaves.delete(id);
    });
}

async function reconcileCanvasProjects(
    token: string,
    remoteProjects: CanvasProject[],
    localProjects: CanvasProject[],
) {
    const owner = currentStorageOwnerId();
    const epoch = ownerEpoch;
    if (!owner || useCanvasStore.getState().ownerUserId !== owner) return [];
    remoteProjects = remoteProjects.map(canonicalProject);
    const remoteById = new Map(remoteProjects.map((project) => [project.id, project]));
    const missingProjects = localProjects.filter(
        (project) => isCanvasProjectHydrated(project) && !remoteById.has(project.id),
    );
    const existingLocalProjects = localProjects.filter((project) => remoteById.has(project.id));
    const projects = missingProjects.length
        ? await syncCanvasProjects(token, missingProjects)
            .then((syncedProjects) => mergeCanvasProjects([...remoteProjects, ...syncedProjects.map(canonicalProject)], []))
            .catch((error) => {
                if (epoch === ownerEpoch && owner === currentStorageOwnerId()) recordSaveError(error);
                return mergeCanvasProjects(remoteProjects, missingProjects);
            })
        : remoteProjects;

    if (epoch !== ownerEpoch || owner !== currentStorageOwnerId()) return [];
    for (const project of existingLocalProjects) {
        if (!isCanvasProjectHydrated(project)) continue;
        const remote = remoteById.get(project.id);
        if (remote && project.pendingSave && project.serverUpdatedAt === remote.updatedAt) {
            const index = projects.findIndex((item) => item.id === project.id);
            if (index >= 0) projects[index] = project;
            queueProjectSave(project);
        } else if (remote && project.pendingSave) {
            const fullRemote = isCanvasProjectHydrated(remote) ? remote : canonicalProject({ ...await getCanvasProject(token, project.id), hydrated: true });
            if (epoch !== ownerEpoch || owner !== currentStorageOwnerId()) return [];
            if (!isCanvasProjectHydrated(fullRemote)) throw new Error("画布数据不完整，请重试");
            const index = projects.findIndex(item => item.id === project.id);
            if (index >= 0) projects[index] = fullRemote;
            recordSaveError(Object.assign(new Error("画布已在其他设备更新，已载入最新版本；本机修改可重试保存"), { status: 409, data: { currentProject: fullRemote } }), project);
        } else if (remote && !isCanvasProjectHydrated(remote)) {
            const index = projects.findIndex(item => item.id === project.id);
            if (index >= 0) projects[index] = project.remoteUpdatedAt === remote.updatedAt
                && project.title === remote.title && project.nodeCount === remote.nodeCount
                && project.connectionCount === remote.connectionCount && project.sessionCount === remote.sessionCount
                ? project : {
                    ...project, title: remote.title, remoteUpdatedAt: remote.updatedAt,
                    serverUpdatedAt: project.serverUpdatedAt ?? project.updatedAt,
                    nodeCount: remote.nodeCount, connectionCount: remote.connectionCount, sessionCount: remote.sessionCount,
                };
        }
    }

    return projects;
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const attempt = ++hydrationAttempt;
        let expired = false;
        let fallback: StorageValue<CanvasStore> | null = null;
        const hydrate = async () => {
        const owner = await waitForStorageOwner();
        if (expired) return null;
        if (!owner) { ownerLoading = false; hydrationFailed = true; recordSaveError(new Error("账号信息暂不可用，请重试加载或重新登录")); return null; }
        resetCanvasOwner(owner);
        const epoch = ownerEpoch;
        const token = useUserStore.getState().token;
        await localSaveInFlight.catch(() => undefined);
        const localParsed = await projectStorage.read(owner, persistentProject) as StorageValue<CanvasStore> | null;
        const isCurrent = () => !expired && attempt === hydrationAttempt && epoch === ownerEpoch && owner === currentStorageOwnerId();
        if (!isCurrent()) return null;
        const localProjects = localParsed?.state.ownerUserId === owner ? localParsed.state.projects || [] : [];
        if (localParsed?.state.ownerUserId === owner && localParsed.state.conflictDrafts) useCanvasStore.setState({ conflictDrafts: localParsed.state.conflictDrafts });
        fallback = localParsed?.state.ownerUserId === owner ? localParsed : null;
        const localHasData =
            Array.isArray(localProjects) && localProjects.length > 0;

        if (token) {
            try {
                const requestToken = useUserStore.getState().token || token;
                const [userConfig, fetchedRemoteProjects] = await Promise.all([
                    fetchUserConfig(requestToken),
                    listCanvasProjects(requestToken, true),
                ]);
                if (!isCurrent()) return null;
                const remoteProjects = fetchedRemoteProjects.map(project => canonicalProject(listedProject(project)));
                accountCanvasSyncEnabled =
                    userConfig.syncCapabilities?.userData === true;

                if (accountCanvasSyncEnabled && localHasData) {
                    const projects = await reconcileCanvasProjects(
                        requestToken,
                        remoteProjects,
                        localProjects,
                    );

                    if (!isCurrent()) return null;
                    const nextState = { projects, ownerUserId: owner, conflictDrafts: useCanvasStore.getState().conflictDrafts };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await persistLocalCanvasValue(parsed);
                    if (!isCurrent()) return null;
                    ownerLoading = false;
                    hydrationFailed = false;
                    return parsed;
                }

                if (
                    remoteProjects.length > 0 &&
                    (accountCanvasSyncEnabled || !localHasData)
                ) {
                    const nextState = { projects: remoteProjects, ownerUserId: owner, conflictDrafts: useCanvasStore.getState().conflictDrafts };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await persistLocalCanvasValue(parsed);
                    if (!isCurrent()) return null;
                    ownerLoading = false;
                    hydrationFailed = false;
                    return parsed;
                }
            } catch (error) {
                console.error(
                    "Failed to hydrate canvas projects from remote",
                    error,
                );
                if (isCurrent()) { hydrationFailed = true; recordSaveError(error); }
            }
        }

        if (!isCurrent()) return null;
        ownerLoading = false;
        if (!localParsed || localParsed.state.ownerUserId !== owner) return { state: { ...useCanvasStore.getState(), projects: [], ownerUserId: owner }, version: 0 };
        queuedPersistState = localParsed.state as PersistedCanvasState;
        return localParsed;
        };
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([hydrate(), new Promise<null>((_resolve, reject) => {
                timeout = setTimeout(() => { expired = true; reject(new Error("画布加载超时，请检查网络后重试")); }, 14000);
            })]);
        } catch (error) {
            expired = true;
            if (attempt !== hydrationAttempt) return null;
            ownerLoading = false;
            hydrationFailed = true;
            recordSaveError(error);
            const localFallback = fallback as StorageValue<CanvasStore> | null;
            return localFallback?.state.ownerUserId === currentStorageOwnerId() ? localFallback : null;
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    },

    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (ownerLoading || !nextState.ownerUserId || nextState.ownerUserId !== currentStorageOwnerId()) return;
        if (
            queuedPersistState &&
            queuedPersistState.projects === nextState.projects &&
            queuedPersistState.conflictDrafts === nextState.conflictDrafts
        ) {
            return;
        }
        queuedPersistState = nextState;
        queuedPersistValue = { name, value };
        if (saveTimer) clearTimeout(saveTimer);
        const flush = () => { void flushLocalCanvasSave().catch(recordSaveError); };
        saveTimer = setTimeout(flush, 400);
        if (!saveMaxTimer) saveMaxTimer = setTimeout(flush, MAX_SAVE_WAIT_MS);
    },
    removeItem: async () => {
        const owner = currentStorageOwnerId();
        if (owner) await projectStorage.remove(owner);
    },
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            ownerUserId: null,
            hydrated: false,
            projects: [],
            syncError: null,
            conflictDrafts: [],
            restoreVersion: 0,
            createProject: (title = "未命名画布", options) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    pendingSave: true,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    agentConfig: options?.agentConfig || null,
                    autoTitlePending: true,
                    pendingAgentRequest: options?.pendingAgentRequest,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    showConnections: true,
                    snapToGrid: false,
                    viewport: initialViewport,
                    sidePanel: DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: options?.pendingAgentRequest ? { ...DEFAULT_CANVAS_AGENT_PANEL, open: true } : DEFAULT_CANVAS_AGENT_PANEL,
                };
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    pendingSave: true,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    agentConfig: source.agentConfig || null,
                    autoTitlePending: false,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    showConnections: source.showConnections ?? true,
                    snapToGrid: source.snapToGrid ?? false,
                    viewport: source.viewport || initialViewport,
                    sidePanel: source.sidePanel || DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: source.agentPanel || DEFAULT_CANVAS_AGENT_PANEL,
                };
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return project.id;
            },
            openProject: (id) =>
                get().projects.find((item) => item.id === id && isCanvasProjectHydrated(item)) || null,
            loadProject: async (id) => {
                const project = get().projects.find(item => item.id === id);
                if (project && isCanvasProjectHydrated(project)
                    && (!project.remoteUpdatedAt || project.remoteUpdatedAt === (project.serverUpdatedAt ?? project.updatedAt) || project.pendingSave)) return project;
                const owner = currentStorageOwnerId();
                const token = useUserStore.getState().token;
                const epoch = ownerEpoch;
                if (!owner || !token || get().ownerUserId !== owner) return null;
                const pending = projectLoadsInFlight.get(id);
                if (pending) return pending;
                const current = () => owner === currentStorageOwnerId() && epoch === ownerEpoch;
                const request = (async () => {
                    const fetched = await getCanvasProject(token, id);
                    if (!current() || deletingProjectIds.has(id)) return null;
                    if (!fetched || fetched.id !== id || !isCanvasProjectHydrated(fetched)) throw new Error("画布数据不完整，请重试");
                    const latest = get().projects.find(item => item.id === id);
                    if (latest !== project && latest?.pendingSave && isCanvasProjectHydrated(latest)) return latest;
                    const complete = canonicalProject({ ...fetched, hydrated: true });
                    set((state) => ({ projects: state.projects.some(item => item.id === id)
                        ? state.projects.map(item => item.id === id ? complete : item)
                        : [complete, ...state.projects] }));
                    return complete;
                })();
                projectLoadsInFlight.set(id, request);
                try { return await request; }
                finally { if (projectLoadsInFlight.get(id) === request) projectLoadsInFlight.delete(id); }
            },
            renameProject: (id, title) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project || !isCanvasProjectEditable(project)) return;
                const nextProject = {
                    ...project,
                    title: title.trim() || project.title,
                    autoTitlePending: false,
                    updatedAt: new Date().toISOString(),
                    remoteUpdatedAt: undefined,
                    // Stale summary counters must not survive an edit, otherwise queueProjectSave
                    // rejects the rename as "not hydrated" and the new title is silently dropped.
                    nodeCount: undefined,
                    connectionCount: undefined,
                    sessionCount: undefined,
                    pendingSave: true,
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            deleteProjects: async (ids) => {
                const owner = currentStorageOwnerId();
                const token = useUserStore.getState().token;
                const projectIds = Array.from(new Set(ids));
                if (!owner || get().ownerUserId !== owner) throw new Error("账号信息尚未就绪，请重试");
                projectIds.forEach((id) => deletingProjectIds.add(id));
                cancelProjectSaves(projectIds);
                if (token && accountCanvasSyncEnabled) {
                    try {
                        await Promise.all(projectIds.map((id) => projectSavesInFlight.get(id)));
                        await deleteCanvasProjects(projectIds);
                    } catch (error) {
                        projectIds.forEach((id) => deletingProjectIds.delete(id));
                        if (owner === currentStorageOwnerId()) {
                            recordSaveError(error);
                            get().projects.filter((project) => projectIds.includes(project.id) && project.pendingSave).forEach(queueProjectSave);
                        }
                        throw error;
                    }
                }
                if (owner !== currentStorageOwnerId()) throw new Error("账号已切换，请重试");
                cancelProjectSaves(ids);
                set((state) => ({
                    projects: state.projects.filter(
                        (project) => !ids.includes(project.id),
                    ),
                    conflictDrafts: state.conflictDrafts.filter((project) => !ids.includes(project.id)),
                }));
                await flushLocalCanvasSave();
                projectIds.forEach((id) => deletingProjectIds.delete(id));
                projectIds.forEach((id) => { failedProjectSaves.delete(id); remoteDeletedProjectIds.delete(id); });
                if (!failedProjectSaves.size && !hydrationFailed) set({ syncError: null });
            },
            updateProject: (id, patch) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project || !isCanvasProjectEditable(project)) return;
                if (Object.entries(patch).every(([key, value]) => Object.is(project[key as keyof CanvasProject], value))) return;
                const nextProject = {
                    ...project,
                    ...patch,
                    updatedAt: new Date().toISOString(),
                    remoteUpdatedAt: undefined,
                    nodeCount: undefined,
                    connectionCount: undefined,
                    sessionCount: undefined,
                    pendingSave: true,
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            syncWithRemote: async (token, syncEnabled) => {
                let owner: string | null;
                try { owner = await waitForStorageOwner(); } catch (error) { ownerLoading = false; set({ hydrated: true }); recordSaveError(error); return; }
                if (!owner) return;
                if (owner !== lastOwnerId || get().ownerUserId !== owner) {
                    resetCanvasOwner(owner);
                    ownerHydration = useCanvasStore.persist.rehydrate() as Promise<void>;
                }
                if (ownerLoading) await (ownerHydration || useCanvasStore.persist.rehydrate());
                if (owner !== currentStorageOwnerId()) return;
                const epoch = ownerEpoch;
                accountCanvasSyncEnabled = syncEnabled;
                if (!syncEnabled) return;
                const localProjects = get().projects;
                const requestToken = useUserStore.getState().token || token;
                const remoteProjects = await listCanvasProjects(requestToken, true).catch((error) => { if (owner === currentStorageOwnerId()) { hydrationFailed = true; recordSaveError(error); } return null; });
                if (!remoteProjects || epoch !== ownerEpoch || owner !== currentStorageOwnerId()) return;
                const projects = await reconcileCanvasProjects(
                    requestToken,
                    remoteProjects.map(listedProject),
                    localProjects,
                );
                if (epoch !== ownerEpoch || owner !== currentStorageOwnerId()) return;
                if (saveTimer) {
                    clearTimeout(saveTimer);
                    saveTimer = null;
                }
                const nextState = { projects, ownerUserId: owner, conflictDrafts: get().conflictDrafts };
                queuedPersistState = nextState;
                set(nextState);
                await persistLocalCanvasValue({ state: nextState, version: 0 } as StorageValue<CanvasStore>);
            },
            setSyncEnabled: (enabled) => {
                accountCanvasSyncEnabled = enabled;
            },
            retrySaves: async () => {
                const owner = currentStorageOwnerId();
                if (!owner || get().ownerUserId !== owner) { await useUserStore.getState().hydrateUser(); await useCanvasStore.persist.rehydrate(); return; }
                if (hydrationFailed || (!accountCanvasSyncEnabled && useUserStore.getState().token)) {
                    await flushLocalCanvasSave();
                    await useCanvasStore.persist.rehydrate();
                    if (hydrationFailed || !accountCanvasSyncEnabled) return;
                }
                const drafts = get().conflictDrafts;
                if (drafts.length) set((state) => ({
                    projects: state.projects.map((project) => {
                        const draft = drafts.find((item) => item.id === project.id);
                        if (!draft) return project;
                        const restored = { ...draft, serverUpdatedAt: project.serverUpdatedAt, pendingSave: true };
                        retryDrafts.set(restored, draft);
                        return restored;
                    }),
                    restoreVersion: state.restoreVersion + 1,
                }));
                get().projects.filter((project) => !remoteDeletedProjectIds.has(project.id) && (project.pendingSave || failedProjectSaves.has(project.id))).forEach(queueProjectSave);
                await flushCanvasSaves();
            },
            importAccountProjects: async (projects, expectedOwner, expectedToken) => {
                void expectedToken;
                const current = () => expectedOwner === currentStorageOwnerId() && get().ownerUserId === expectedOwner;
                if (!current()) throw new Error("账号已切换，导入已暂停");
                if (ownerLoading) await (ownerHydration || useCanvasStore.persist.rehydrate());
                if (!current() || ownerLoading) throw new Error("账号信息尚未就绪，导入可重试");
                set((state) => {
                    const existing = new Set(state.projects.map((project) => project.id));
                    return { projects: [...state.projects, ...projects.filter((project) => !existing.has(project.id)).map(canonicalProject)] };
                });
                await flushLocalCanvasSave();
                if (!current()) throw new Error("账号已切换，导入已暂停");
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) => ({ ownerUserId: state.ownerUserId, projects: state.projects, conflictDrafts: state.conflictDrafts }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                if (!ownerLoading) useCanvasStore.setState({ hydrated: true, ...(!hydrationFailed && !failedProjectSaves.size && !useCanvasStore.getState().conflictDrafts.length ? { syncError: null } : {}) });
            },
            merge: (persisted, current) => {
                const state = persisted as PersistedCanvasState | undefined;
                return state?.ownerUserId === currentStorageOwnerId() ? { ...current, ...state } : current;
            },
        },
    ),
);

useUserStore.subscribe(() => {
    const owner = currentStorageOwnerId();
    if (owner === lastOwnerId) return;
    resetCanvasOwner(owner);
    if (owner) ownerHydration = useCanvasStore.persist.rehydrate() as Promise<void>;
});

if (typeof window !== "undefined" && window.addEventListener) {
    const flush = () => { void flushCanvasSaves().catch(recordSaveError); };
    window.addEventListener("pagehide", flush);
    if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
    });
}

export function mergeCanvasProjects(
    remoteProjects: CanvasProject[],
    localProjects: CanvasProject[],
): CanvasProject[] {
    const projects = new Map<string, CanvasProject>();
    [...localProjects, ...remoteProjects].forEach((project) => {
        const previous = projects.get(project.id);
        if (
            !previous ||
            Date.parse(project.updatedAt || "") >=
            Date.parse(previous.updatedAt || "")
        ) {
            projects.set(project.id, project);
        }
    });
    return Array.from(projects.values()).sort(
        (a, b) =>
            Date.parse(b.updatedAt || "") -
            Date.parse(a.updatedAt || ""),
    );
}
