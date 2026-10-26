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
    if (metadata.groupId) metadata.groupId = idMap.get(metadata.groupId);
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
