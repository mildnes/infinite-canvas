import type { CanvasGenerationMode, CanvasNodeData } from "../types";

export type NodeRegenerateBehavior = "new-node" | "overwrite";

export function shouldOverwriteCanvasNode(
    behavior: NodeRegenerateBehavior | undefined,
    mode: CanvasGenerationMode,
    sourceNode?: CanvasNodeData,
) {
    return behavior === "overwrite" && sourceNode?.type === mode && !sourceNode.metadata?.isBatchRoot;
}

export function prepareCanvasNodeOverwrite(sourceNode: CanvasNodeData, generatedNode: CanvasNodeData): CanvasNodeData {
    return {
        ...generatedNode,
        id: sourceNode.id,
        title: sourceNode.title,
        position: { ...sourceNode.position },
        width: sourceNode.width,
        height: sourceNode.height,
        metadata: {
            ...sourceNode.metadata,
            content: undefined,
            storageKey: "",
            mediaStatus: undefined,
            mediaError: undefined,
            mimeType: undefined,
            bytes: undefined,
            durationMs: undefined,
            progress: 0,
            stopState: undefined,
            errorDetails: undefined,
            taskPollError: undefined,
            imageTaskId: undefined,
            imageTaskResultId: undefined,
            videoTaskId: undefined,
            videoTaskVideoId: undefined,
            audioTaskId: undefined,
            audioTaskResultId: undefined,
            ...generatedNode.metadata,
        },
    };
}
