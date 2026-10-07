import { apiDelete, apiGet, apiPost } from "@/services/api/request";
import type { UserWebDAVStorageProvider } from "@/services/image-storage";

export type RegisteredStorageObject = {
    url: string;
    storageKey: string;
    bytes: number;
    mimeType: string;
};

export type StorageObjectInfo = {
    id: string;
    objectKey: string;
    publicUrl: string;
    mimeType: string;
    bytes: number;
    direct: boolean;
    cloudSyncedAt?: string;
    cloudCheckedAt?: string;
    cloudVerifiedAt?: string;
    cloudCheckStatus?: string;
    cloudSyncStatus?: string;
    cloudSyncError?: string;
    cloudSyncAttempts?: number;
    cloudSyncLastAttemptAt?: string;
    cloudSyncNextRetryAt?: string;
};

export function getStorageObjectInfo(id: string) {
    return apiGet<StorageObjectInfo>(`/api/files/${encodeURIComponent(id)}`);
}

export function registerDirectStorageObject(
    token: string,
    payload: { provider: UserWebDAVStorageProvider; objectKey: string; mimeType: string; bytes: number },
) {
    return apiPost<RegisteredStorageObject>("/api/v1/files/direct", payload, token);
}

export function deleteDirectStorageObjectRecord(token: string, id: string) {
    return apiDelete<boolean>(`/api/v1/files/${encodeURIComponent(id)}/record`, token);
}

export async function uploadStoragePreview(token: string, id: string, blob: Blob, signal?: AbortSignal) {
    const response = await fetch(`/api/v1/files/${encodeURIComponent(id)}/preview`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": blob.type }, body: blob, signal });
    if (!response.ok) throw new Error("图片预览缓存提交失败");
}
