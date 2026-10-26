import { saveAs } from "file-saver";

import { createZip } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasNodeData } from "../types";

const DOWNLOADABLE_NODE_TYPES = new Set(["image", "panorama", "video", "audio"]);

export type CanvasNodeDownloadSelection = {
    selectedNodes: CanvasNodeData[];
    downloadableNodes: CanvasNodeData[];
    selectedCount: number;
    skippedCount: number;
};

export type CanvasNodeDownloadFailure = {
    nodeId: string;
    title: string;
    reason: string;
};

export type CanvasNodeDownloadResult = {
    selectedCount: number;
    downloadableCount: number;
    skippedCount: number;
    downloadedCount: number;
    failures: CanvasNodeDownloadFailure[];
};

export function prepareCanvasNodeDownloadSelection(
    nodes: CanvasNodeData[],
    selectedNodeIds: ReadonlySet<string>,
): CanvasNodeDownloadSelection {
    const selectedNodes = nodes.filter((node) => selectedNodeIds.has(node.id));
    const downloadableNodes = selectedNodes.filter((node) => {
        if (!DOWNLOADABLE_NODE_TYPES.has(node.type)) return false;
        return Boolean(node.metadata?.content?.trim() || node.metadata?.storageKey?.trim());
    });
    return {
        selectedNodes,
        downloadableNodes,
        selectedCount: selectedNodes.length,
        skippedCount: selectedNodes.length - downloadableNodes.length,
    };
}

export async function downloadSelectedCanvasNodes(
    selection: CanvasNodeDownloadSelection,
    options: { token: string; projectTitle: string; now?: Date },
): Promise<CanvasNodeDownloadResult> {
    const outcomes = await Promise.allSettled(selection.downloadableNodes.map(async (node) => ({
        node,
        blob: await loadNodeBlob(node, options.token),
        fileName: canvasNodeDownloadFileName(node),
    })));
    const files: { name: string; data: Blob }[] = [];
    const failures: CanvasNodeDownloadFailure[] = [];
    outcomes.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") {
            files.push({ name: outcome.value.fileName, data: outcome.value.blob });
        } else {
            const node = selection.downloadableNodes[index];
            failures.push({
                nodeId: node.id,
                title: node.title || node.id,
                reason: errorMessage(outcome.reason),
            });
        }
    });

    if (files.length === 1 && selection.selectedCount === 1 && !failures.length && !selection.skippedCount) {
        saveAs(files[0].data, files[0].name);
    } else if (files.length > 0) {
        const zip = await createZip(files);
        saveAs(zip, `${safeFileName(options.projectTitle || "画板")}-选中${selection.selectedCount}个-${formatDownloadTime(options.now || new Date())}.zip`);
    }

    return {
        selectedCount: selection.selectedCount,
        downloadableCount: selection.downloadableNodes.length,
        skippedCount: selection.skippedCount,
        downloadedCount: files.length,
        failures,
    };
}

export function canvasNodeDownloadFileName(node: CanvasNodeData) {
    const mimeType = node.metadata?.mimeType;
    const content = node.metadata?.content || "";
    const extension = node.type === "video"
        ? "mp4"
        : node.type === "audio"
            ? audioExtension(mimeType)
            : imageExtension(content, mimeType);
    return `canvas-${node.type}-${node.id}.${extension}`;
}

export function imageExtension(dataUrl: string, mimeType?: string) {
    const extension = mimeType?.toLowerCase().match(/^image[/]([^;+]+)/)?.[1] || dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
    return extension === "jpeg" ? "jpg" : extension;
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

async function loadNodeBlob(node: CanvasNodeData, token: string) {
    const content = node.metadata?.content?.trim() || "";
    const storageKey = node.metadata?.storageKey?.trim() || "";
    const serverId = storageKey.startsWith("server:") ? storageKey.slice("server:".length) : "";
    const contentIsFileEndpoint = content.startsWith("/api/files/") && /\/content(?:[?#].*)?$/.test(content);

    if (serverId || contentIsFileEndpoint) {
        const url = serverId ? `/api/files/${encodeURIComponent(serverId)}/content` : content;
        const response = await fetch(url, {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return requireNonEmptyBlob(await response.blob());
    }

    if (storageKey.startsWith("image:")) {
        const blob = await getImageBlob(storageKey);
        if (blob) return requireNonEmptyBlob(blob);
    } else if (storageKey) {
        const blob = await getMediaBlob(storageKey);
        if (blob) return requireNonEmptyBlob(blob);
    }

    if (content) {
        const response = await fetch(content);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return requireNonEmptyBlob(await response.blob());
    }
    throw new Error("本地素材不存在");
}

function requireNonEmptyBlob(blob: Blob) {
    if (!blob.size) throw new Error("素材文件为空");
    return blob;
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : "下载失败";
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "画板";
}

function formatDownloadTime(date: Date) {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
