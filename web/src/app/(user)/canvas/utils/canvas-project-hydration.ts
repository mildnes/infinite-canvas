import type { CanvasProject } from "../stores/use-canvas-store";

export type CanvasProjectSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt"> & {
    nodeCount: number;
    connectionCount: number;
    sessionCount: number;
};

export function isCanvasProjectHydrated(project: Partial<CanvasProject>): boolean {
    return project.hydrated !== false
        && Array.isArray(project.nodes)
        && (project.nodeCount === undefined || project.nodeCount === project.nodes.length);
}

export function canvasProjectRequestData(project: CanvasProject) {
    const {
        serverUpdatedAt: _serverUpdatedAt, pendingSave: _pendingSave,
        hydrated: _hydrated, nodeCount: _nodeCount, connectionCount: _connectionCount,
        sessionCount: _sessionCount, remoteUpdatedAt: _remoteUpdatedAt, ...data
    } = project;
    return data;
}
