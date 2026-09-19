import { apiDelete, apiGet, apiPost } from "@/services/api/request";

export type GenerationLogsPage<T> = {
    items: T[];
    nextCursor?: string | null;
};

export async function fetchVideoGenerationLogs<T>(token: string) {
    return apiGet<T[]>("/api/v1/generation-logs/videos", undefined, token);
}

export async function saveVideoGenerationLogs<T>(token: string, logs: T[]) {
    return apiPost<T[]>("/api/v1/generation-logs/videos", { logs }, token);
}

export async function deleteVideoGenerationLog(token: string, id: string) {
    return apiDelete<{ deleted: boolean }>(`/api/v1/generation-logs/videos/${encodeURIComponent(id)}`, token);
}

export async function deleteVideoGenerationLogs(token: string, ids: string[]) {
    return apiPost<{ deleted: boolean }>("/api/v1/generation-logs/videos/delete", { ids }, token);
}

export async function fetchImageGenerationLogs<T>(token: string) {
    return apiGet<T[]>("/api/v1/generation-logs/images", undefined, token);
}

export async function fetchImageGenerationLogsPage<T>(token: string, limit = 40, cursor?: string | null) {
    return apiGet<GenerationLogsPage<T>>("/api/v1/generation-logs/images/page", { limit, cursor: cursor || undefined }, token);
}

export async function fetchImageGenerationLog<T>(token: string, id: string) {
    return apiGet<T>(`/api/v1/generation-logs/images/${encodeURIComponent(id)}`, undefined, token);
}

export async function saveImageGenerationLogs<T>(token: string, logs: T[]) {
    return apiPost<T[]>("/api/v1/generation-logs/images", { logs }, token);
}

export async function upsertImageGenerationLogs<T>(token: string, logs: T[]) {
    return apiPost<{ saved: boolean }>("/api/v1/generation-logs/images/upsert", { logs }, token);
}

export async function deleteImageGenerationLogs(token: string, ids: string[]) {
    return apiPost<{ deleted: boolean }>("/api/v1/generation-logs/images/delete", { ids }, token);
}

export async function deleteImageWorkbenchLogs(token: string, ids: string[], taskIds: string[]) {
    return apiPost<{ deleted: boolean }>("/api/v1/generation-logs/images/workbench-delete", { ids, taskIds }, token);
}

