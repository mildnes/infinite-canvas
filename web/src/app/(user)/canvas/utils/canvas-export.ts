import { saveAs } from "file-saver";

import { createZip } from "@/lib/zip";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import type {
    CanvasExportAsset,
    CanvasExportFile,
    CanvasExportMissingAsset,
    CanvasExportResult,
} from "../export-types";
import type { CanvasProject } from "../stores/use-canvas-store";
import { isCanvasProjectHydrated } from "./canvas-project-hydration";

export async function exportCanvasProjects(
    projects: CanvasProject[],
    fileName = "无限画布",
): Promise<CanvasExportResult> {
    if (projects.some(project => !isCanvasProjectHydrated(project))) throw new Error("画布尚未完整加载，不能导出");
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const missing: CanvasExportMissingAsset[] = [];
    const token = useUserStore.getState().token;
    let cloudAssetCount = 0;
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            await Promise.all(
                collectStorageKeys(project).map(async (storageKey) => {
                    const cloudAsset = storageKey.startsWith("server:");
                    if (cloudAsset) cloudAssetCount += 1;
                    const loaded = await loadExportBlob(storageKey, token);
                    if ("missing" in loaded) {
                        missing.push({ storageKey, reason: loaded.reason });
                        return;
                    }
                    const { blob } = loaded;
                    const fileNameKey = cloudAsset ? storageKey.slice("server:".length) : storageKey;
                    const path = `projects/${project.id}/files/${safeFileName(fileNameKey)}.${fileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            return { project, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
        }),
    );

    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
    return { cloudAssetCount, missing };
}

export function countCanvasCloudAssets(projects: CanvasProject[]) {
    return projects.reduce(
        (count, project) => count + collectStorageKeys(project).filter((key) => key.startsWith("server:")).length,
        0,
    );
}

export async function restoreCanvasExportAsset(
    asset: Pick<CanvasExportAsset, "storageKey" | "mimeType">,
    blob: Blob,
) {
    if (asset.storageKey.startsWith("server:")) return false;
    const typedBlob = blob.type ? blob : blob.slice(0, blob.size, asset.mimeType);
    if (asset.storageKey.startsWith("image:")) {
        await setImageBlob(asset.storageKey, typedBlob);
    } else {
        await setMediaBlob(asset.storageKey, typedBlob);
    }
    return true;
}

async function loadExportBlob(
    storageKey: string,
    token: string,
): Promise<{ blob: Blob } | { missing: true; reason: string }> {
    if (storageKey.startsWith("server:")) {
        const id = storageKey.slice("server:".length);
        try {
            const response = await fetch(`/api/files/${encodeURIComponent(id)}/content`, {
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            });
            if (!response.ok) return { missing: true, reason: `云端下载失败（HTTP ${response.status}）` };
            const blob = await response.blob();
            if (!blob.size) return { missing: true, reason: "云端文件为空" };
            return { blob };
        } catch (error) {
            return { missing: true, reason: error instanceof Error ? error.message : "云端下载失败" };
        }
    }
    const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
    return blob ? { blob } : { missing: true, reason: "本地素材不存在" };
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
