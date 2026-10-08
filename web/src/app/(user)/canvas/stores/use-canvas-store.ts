import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage, currentStorageOwnerId, waitForStorageOwner } from "@/lib/localforage-storage";
import { listCanvasProjects, saveCanvasProject, syncCanvasProjects } from "@/services/api/canvas-tasks";
import { fetchUserConfig } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAgentConfig, CanvasAssistantSession, CanvasConnection, CanvasNodeData, CanvasPendingAgentRequest, ViewportTransform } from "../types";
import { sanitizeCanvasNodesForPersistence, sanitizeCanvasSessionsForPersistence } from "../utils/canvas-media-persistence";

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
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    agentConfig: CanvasAgentConfig | null;
    autoTitlePending: boolean;
    pendingAgentRequest?: CanvasPendingAgentRequest;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    sidePanel: CanvasSidePanelState;
    agentPanel: CanvasSidePanelState;
};

type CanvasStore = {
    ownerUserId: string | null;
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string, options?: { agentConfig?: CanvasAgentConfig; pendingAgentRequest?: CanvasPendingAgentRequest }) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "agentConfig" | "autoTitlePending" | "backgroundMode" | "showImageInfo" | "viewport" | "sidePanel" | "agentPanel" | "pendingAgentRequest">>) => void;
    syncWithRemote: (token: string, syncEnabled: boolean) => Promise<void>;
    setSyncEnabled: (enabled: boolean) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects" | "ownerUserId">;
let lastOwnerId: string | null = null;
let ownerEpoch = 0;
let ownerLoading = true;
let ownerHydration: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let accountCanvasSyncEnabled = false;
const projectSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function resetCanvasOwner(owner: string | null) {
    if (lastOwnerId === owner) return;
    lastOwnerId = owner;
    ownerEpoch++;
    ownerLoading = true;
    accountCanvasSyncEnabled = false;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    queuedPersistState = null;
    cancelProjectSaves([...projectSaveTimers.keys()]);
    useCanvasStore.setState({ projects: [], ownerUserId: owner, hydrated: false });
}

function queueProjectSave(project: CanvasProject) {
    const owner = currentStorageOwnerId();
    if (!owner || useCanvasStore.getState().ownerUserId !== owner) return;
    const token = useUserStore.getState().token;
    const syncEnabled = accountCanvasSyncEnabled;
    const previous = projectSaveTimers.get(project.id);
    if (previous) clearTimeout(previous);

    projectSaveTimers.set(
        project.id,
        setTimeout(() => {
            projectSaveTimers.delete(project.id);
            if (
                !token ||
                !syncEnabled ||
                !accountCanvasSyncEnabled ||
                useUserStore.getState().token !== token
                || currentStorageOwnerId() !== owner
            ) {
                return;
            }
            void saveCanvasProject(token, {
                ...project,
                nodes: sanitizeCanvasNodesForPersistence(project.nodes),
                chatSessions: sanitizeCanvasSessionsForPersistence(project.chatSessions || []),
            }).catch(() => undefined);
        }, 400),
    );
}

function cancelProjectSaves(ids: string[]) {
    ids.forEach((id) => {
        const timer = projectSaveTimers.get(id);
        if (!timer) return;
        clearTimeout(timer);
        projectSaveTimers.delete(id);
    });
}

async function reconcileCanvasProjects(
    token: string,
    remoteProjects: CanvasProject[],
    localProjects: CanvasProject[],
) {
    const owner = currentStorageOwnerId();
    const epoch = ownerEpoch;
    if (!owner || token !== useUserStore.getState().token || useCanvasStore.getState().ownerUserId !== owner) return [];
    const remoteById = new Map(
        remoteProjects.map((project) => [project.id, project]),
    );
    const missingProjects = localProjects.filter(
        (project) => !remoteById.has(project.id),
    );
    const existingLocalProjects = localProjects.filter((project) =>
        remoteById.has(project.id),
    );
    const projects = missingProjects.length
        ? await syncCanvasProjects(token, missingProjects)
            .then((syncedProjects) =>
                mergeCanvasProjects(
                    syncedProjects,
                    existingLocalProjects,
                ),
            )
            .catch(() =>
                mergeCanvasProjects(remoteProjects, localProjects),
            )
        : mergeCanvasProjects(remoteProjects, existingLocalProjects);

    if (epoch !== ownerEpoch || owner !== currentStorageOwnerId() || token !== useUserStore.getState().token) return [];
    localProjects.forEach((project) => {
        const remote = remoteById.get(project.id);
        if (
            remote &&
            Date.parse(project.updatedAt || "") >
            Date.parse(remote.updatedAt || "")
        ) {
            queueProjectSave(project);
        }
    });

    return projects;
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const owner = await waitForStorageOwner();
        if (!owner) return null;
        resetCanvasOwner(owner);
        const epoch = ownerEpoch;
        const token = useUserStore.getState().token;
        const localValue = await localForageStorage.getItem(name);
        const isCurrent = () => epoch === ownerEpoch && owner === currentStorageOwnerId() && token === useUserStore.getState().token;
        if (!isCurrent()) return null;
        const localParsed = localValue
            ? (JSON.parse(localValue) as StorageValue<CanvasStore>)
            : null;
        const localProjects = localParsed?.state.ownerUserId === owner ? localParsed.state.projects || [] : [];
        const localHasData =
            Array.isArray(localProjects) && localProjects.length > 0;

        if (token) {
            try {
                const [userConfig, remoteProjects] = await Promise.all([
                    fetchUserConfig(token),
                    listCanvasProjects(token),
                ]);
                if (!isCurrent()) return null;
                accountCanvasSyncEnabled =
                    userConfig.syncCapabilities?.userData === true;

                if (accountCanvasSyncEnabled && localHasData) {
                    const projects = await reconcileCanvasProjects(
                        token,
                        remoteProjects,
                        localProjects,
                    );

                    if (!isCurrent()) return null;
                    const nextState = { projects, ownerUserId: owner };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await localForageStorage.setItem(
                        name,
                        JSON.stringify(parsed),
                    );
                    if (!isCurrent()) return null;
                    ownerLoading = false;
                    return parsed;
                }

                if (
                    remoteProjects.length > 0 &&
                    (accountCanvasSyncEnabled || !localHasData)
                ) {
                    const nextState = { projects: remoteProjects, ownerUserId: owner };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await localForageStorage.setItem(
                        name,
                        JSON.stringify(parsed),
                    );
                    if (!isCurrent()) return null;
                    ownerLoading = false;
                    return parsed;
                }
            } catch (error) {
                console.error(
                    "Failed to hydrate canvas projects from remote",
                    error,
                );
            }
        }

        if (!isCurrent()) return null;
        ownerLoading = false;
        if (!localParsed || localParsed.state.ownerUserId !== owner) return { state: { ...useCanvasStore.getState(), projects: [], ownerUserId: owner }, version: 0 };
        queuedPersistState = localParsed.state as PersistedCanvasState;
        return localParsed;
    },

    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (ownerLoading || !nextState.ownerUserId || nextState.ownerUserId !== currentStorageOwnerId()) return;
        if (
            queuedPersistState &&
            queuedPersistState.projects === nextState.projects
        ) {
            return;
        }
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void localForageStorage.setItem(name, JSON.stringify(value));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            ownerUserId: null,
            hydrated: false,
            projects: [],
            createProject: (title = "未命名画布", options) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    agentConfig: options?.agentConfig || null,
                    autoTitlePending: true,
                    pendingAgentRequest: options?.pendingAgentRequest,
                    backgroundMode: "lines",
                    showImageInfo: false,
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
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    agentConfig: source.agentConfig || null,
                    autoTitlePending: false,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
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
                get().projects.find((item) => item.id === id) || null,
            renameProject: (id, title) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = {
                    ...project,
                    title: title.trim() || project.title,
                    autoTitlePending: false,
                    updatedAt: new Date().toISOString(),
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            deleteProjects: (ids) => {
                cancelProjectSaves(ids);
                set((state) => ({
                    projects: state.projects.filter(
                        (project) => !ids.includes(project.id),
                    ),
                }));
            },
            updateProject: (id, patch) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = {
                    ...project,
                    ...patch,
                    updatedAt: new Date().toISOString(),
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            syncWithRemote: async (token, syncEnabled) => {
                const owner = await waitForStorageOwner();
                if (!owner || token !== useUserStore.getState().token) return;
                if (owner !== lastOwnerId || get().ownerUserId !== owner) {
                    resetCanvasOwner(owner);
                    ownerHydration = useCanvasStore.persist.rehydrate() as Promise<void>;
                }
                if (ownerLoading) await (ownerHydration || useCanvasStore.persist.rehydrate());
                if (owner !== currentStorageOwnerId() || token !== useUserStore.getState().token) return;
                const epoch = ownerEpoch;
                accountCanvasSyncEnabled = syncEnabled;
                if (!syncEnabled) return;
                const localProjects = get().projects;
                const remoteProjects = await listCanvasProjects(token).catch(
                    () => null,
                );
                if (!remoteProjects || epoch !== ownerEpoch || owner !== currentStorageOwnerId() || token !== useUserStore.getState().token) return;
                const projects = await reconcileCanvasProjects(
                    token,
                    remoteProjects,
                    localProjects,
                );
                if (epoch !== ownerEpoch || owner !== currentStorageOwnerId() || token !== useUserStore.getState().token) return;
                if (saveTimer) {
                    clearTimeout(saveTimer);
                    saveTimer = null;
                }
                const nextState = { projects, ownerUserId: owner };
                queuedPersistState = nextState;
                set(nextState);
                await localForageStorage.setItem(
                    CANVAS_STORE_KEY,
                    JSON.stringify({ state: nextState, version: 0 }),
                );
            },
            setSyncEnabled: (enabled) => {
                accountCanvasSyncEnabled = enabled;
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    ownerUserId: state.ownerUserId,
                    projects: state.projects.map((project) => ({
                        ...project,
                        nodes: sanitizeCanvasNodesForPersistence(project.nodes),
                        chatSessions: sanitizeCanvasSessionsForPersistence(project.chatSessions || []),
                    })),
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                if (!ownerLoading) useCanvasStore.setState({ hydrated: true });
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
