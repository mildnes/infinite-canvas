import type { CanvasProject } from "./stores/use-canvas-store";

export type CanvasExportFile = {
    app: "infinite-canvas";
    version: 3;
    exportedAt: string;
    projects: CanvasProjectExportItem[];
};

export type CanvasProjectExportItem = {
    project: CanvasProject;
    files: CanvasExportAsset[];
};

export type CanvasExportAsset = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export type CanvasExportMissingAsset = {
    storageKey: string;
    reason: string;
};

export type CanvasExportResult = {
    cloudAssetCount: number;
    missing: CanvasExportMissingAsset[];
};
