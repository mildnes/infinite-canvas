import { CanvasNodeType, type CanvasNodeData } from "../types";
import { fitNodeSize } from "./canvas-node-size";

export const IMAGE_NODE_DEFAULT_SIZE = { width: 420, height: 236 } as const;
export const VIDEO_NODE_DEFAULT_SIZE = { width: 420, height: 236 } as const;

type GeneratedMediaSizeInput = Pick<CanvasNodeData, "type" | "width" | "height" | "metadata">;

export function isGeneratedMediaNode(node: Pick<CanvasNodeData, "type" | "metadata">) {
    if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video) return false;
    if (node.metadata?.isBatchRoot || node.metadata?.batchRootId || node.metadata?.freeResize) return false;
    return node.type === CanvasNodeType.Image
        ? Boolean(node.metadata?.imageTaskId || node.metadata?.imageTaskResultId)
        : Boolean(node.metadata?.videoTaskId || node.metadata?.videoTaskVideoId);
}

export function resolveGeneratedMediaSize(node: GeneratedMediaSizeInput, naturalWidth: number, naturalHeight: number) {
    if (!isGeneratedMediaNode(node) || !Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) return null;
    const max = node.type === CanvasNodeType.Image ? IMAGE_NODE_DEFAULT_SIZE : VIDEO_NODE_DEFAULT_SIZE;
    return fitNodeSize(naturalWidth, naturalHeight, max.width, max.height);
}

export function centerResizedNodeSize(node: Pick<CanvasNodeData, "width" | "height" | "position">, size: { width: number; height: number }) {
    return {
        ...size,
        position: {
            x: node.position.x + node.width / 2 - size.width / 2,
            y: node.position.y + node.height / 2 - size.height / 2,
        },
    };
}
