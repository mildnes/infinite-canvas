import type { CanvasNodeData } from "../types";

// Only a complete selected batch owns its newly copied children.
export function copiedCanvasNodeMetadata(
    node: CanvasNodeData,
    selected: CanvasNodeData[],
    idMap: Map<string, string>,
): CanvasNodeData["metadata"] {
    if (!node.metadata) return undefined;
    const metadata = { ...node.metadata };
    for (const key of [
        "isBatchRoot", "batchChildIds", "batchRootId", "primaryImageId", "imageBatchExpanded",
        "imageTaskId", "imageTaskResultId", "audioTaskId", "audioTaskResultId", "videoTaskId", "videoTaskVideoId",
        "startedAt", "progress", "stopState", "errorDetails", "taskPollError",
    ] as const) delete metadata[key];
    metadata.status = metadata.content ? "success" : "idle";
    const remapNodeId = (id: string | undefined) => (id ? idMap.get(id) || id : id);
    if (metadata.groupId) metadata.groupId = idMap.get(metadata.groupId);
    if (metadata.composerContent) {
        metadata.composerContent = metadata.composerContent.replace(/@\[node:([^\]]+)\]/g, (token, id: string) => {
            const copiedId = idMap.get(id);
            return copiedId ? `@[node:${copiedId}]` : token;
        });
    }
    for (const key of ["firstFrameNodeId", "lastFrameNodeId", "referenceAudioNodeId", "mimoVoiceCloneAudioNodeId"] as const) {
        metadata[key] = remapNodeId(metadata[key]);
    }
    if (metadata.klingImageNodeIds) metadata.klingImageNodeIds = metadata.klingImageNodeIds.map((id) => remapNodeId(id)!);
    if (metadata.klingMultiPrompt) {
        metadata.klingMultiPrompt = metadata.klingMultiPrompt.map((item) => ({
            ...item,
            textNodeId: remapNodeId(item.textNodeId),
        }));
    }
    if (metadata.klingElementList) {
        metadata.klingElementList = metadata.klingElementList.map((item) => ({
            ...item,
            nodeIds: item.nodeIds?.map((id) => remapNodeId(id)!),
        }));
    }
    const root = selected.find(item => item.id === (node.metadata?.isBatchRoot ? node.id : node.metadata?.batchRootId));
    const children = root?.metadata?.batchChildIds;
    if (root?.metadata?.isBatchRoot && children?.length
        && children.every(id => idMap.has(id) && selected.some(item => item.id === id && item.metadata?.batchRootId === root.id))) {
        if (node.id === root.id) {
            metadata.isBatchRoot = true;
            metadata.batchChildIds = children.map(id => idMap.get(id)!);
            metadata.primaryImageId = idMap.get(root.metadata.primaryImageId || "") || metadata.batchChildIds[0];
            metadata.imageBatchExpanded = root.metadata.imageBatchExpanded;
        } else {
            metadata.batchRootId = idMap.get(root.id);
        }
    }
    return metadata;
}
