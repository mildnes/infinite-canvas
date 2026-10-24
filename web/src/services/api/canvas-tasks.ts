import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import { canvasProjectRequestData, isCanvasProjectHydrated, type CanvasProjectSummary } from "@/app/(user)/canvas/utils/canvas-project-hydration";
import { apiGet, apiPost } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

export function listCanvasProjects(token: string): Promise<CanvasProject[]>;
export function listCanvasProjects(token: string, summary: true): Promise<CanvasProjectSummary[]>;
export function listCanvasProjects(token: string, summary?: true) {
    return apiGet<CanvasProject[] | CanvasProjectSummary[]>(summary ? "/api/v1/canvas/projects?summary=1" : "/api/v1/canvas/projects", undefined, token);
}

export function getCanvasProject(token: string, id: string) {
    return apiGet<CanvasProject>("/api/v1/canvas/projects/" + encodeURIComponent(id), undefined, token);
}

export async function saveCanvasProject(
    token: string,
    project: CanvasProject,
    baseUpdatedAt = project.serverUpdatedAt ?? "",
) {
    if (!isCanvasProjectHydrated(project)) throw new Error("画布尚未完整加载，不能保存");
    const data = canvasProjectRequestData(project);
    return apiPost<CanvasProject>(
        "/api/v1/canvas/projects",
        { data, baseUpdatedAt },
        token,
    );
}

export async function syncCanvasProjects(
    token: string,
    projects: CanvasProject[],
    baseUpdatedAts = Object.fromEntries(projects.map((project) => [project.id, project.serverUpdatedAt ?? ""])),
) {
    const complete = projects.filter(isCanvasProjectHydrated);
    if (!complete.length) return [];
    return apiPost<CanvasProject[]>(
        "/api/v1/canvas/projects/sync",
        { projects: complete.map(canvasProjectRequestData), baseUpdatedAts: Object.fromEntries(complete.map(project => [project.id, baseUpdatedAts[project.id]])) },
        token,
    );
}

export async function deleteCanvasTasks(sourceId: string, nodeIds: string[] = []) {
    const token = useUserStore.getState().token;
    const source = sourceId.trim();
    if (!token || !source) return;
    return apiPost<{ deleted: boolean }>(
        "/api/v1/canvas/tasks/delete",
        {
            source_id: source,
            node_ids: Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean))),
        },
        token,
    );
}

export async function stopCanvasTask(kind: "image" | "audio" | "video" | "workflow", taskId: string) {
    const token = useUserStore.getState().token;
    if (!token || !taskId.trim()) return;
    return apiPost<{ status: string; stopped: boolean; creditsRefunded: boolean }>("/api/v1/canvas/tasks/stop", { kind, taskId: taskId.trim() }, token);
}

export async function deleteCanvasProjects(ids: string[]) {
    const token = useUserStore.getState().token;
    const projectIds = Array.from(
        new Set(ids.map((id) => id.trim()).filter(Boolean)),
    );
    if (!token || !projectIds.length) return;
    return apiPost<{ deleted: boolean }>(
        "/api/v1/canvas/projects/delete",
        { ids: projectIds },
        token,
    );
}
