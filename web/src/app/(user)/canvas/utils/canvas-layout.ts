import { CanvasNodeType, type CanvasNodeData, type Position } from "../types";

export const CANVAS_GRID_SIZE = 48;
export const CANVAS_ARRANGE_GAP = 72;
export const CANVAS_ARRANGE_COLUMNS = 4;

export function snapToCanvasGrid(position: Position, gridSize = CANVAS_GRID_SIZE): Position {
    if (!Number.isFinite(gridSize) || gridSize <= 0) return position;
    return { x: Math.round(position.x / gridSize) * gridSize, y: Math.round(position.y / gridSize) * gridSize };
}

export function snapNodesToCanvasGrid(nodes: CanvasNodeData[], movedIds: Set<string>, gridSize = CANVAS_GRID_SIZE): CanvasNodeData[] {
    const anchors = nodes.filter((node) => movedIds.has(node.id) && !node.metadata?.batchRootId && node.type !== CanvasNodeType.Group);
    const anchor = anchors.length ? anchors.reduce((best, node) => (node.position.x < best.position.x || (node.position.x === best.position.x && node.position.y < best.position.y) ? node : best), anchors[0]) : null;
    if (!anchor) return nodes;
    const snapped = snapToCanvasGrid(anchor.position, gridSize);
    const dx = snapped.x - anchor.position.x;
    const dy = snapped.y - anchor.position.y;
    if (!dx && !dy) return nodes;
    return nodes.map((node) => (movedIds.has(node.id) ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node));
}

export function arrangeCanvasNodes(nodes: CanvasNodeData[]): CanvasNodeData[] {
    const declaredBatchChildIds = new Set(nodes.flatMap((node) => node.metadata?.batchChildIds || []));
    const targets = nodes.filter((node) => !node.metadata?.groupId && !node.metadata?.batchRootId && !declaredBatchChildIds.has(node.id));
    if (!targets.length) return nodes;
    const startX = Math.min(...targets.map((node) => node.position.x));
    const startY = Math.min(...targets.map((node) => node.position.y));
    const positions = new Map<string, Position>();
    let x = startX;
    let y = startY;
    let rowHeight = 0;
    targets.forEach((node, index) => {
        if (index > 0 && index % CANVAS_ARRANGE_COLUMNS === 0) {
            x = startX;
            y += rowHeight + CANVAS_ARRANGE_GAP;
            rowHeight = 0;
        }
        positions.set(node.id, { x, y });
        x += node.width + CANVAS_ARRANGE_GAP;
        rowHeight = Math.max(rowHeight, node.height);
    });
    targets
        .filter((node) => node.type === CanvasNodeType.Group)
        .forEach((group) => {
            const target = positions.get(group.id);
            if (!target) return;
            const dx = target.x - group.position.x;
            const dy = target.y - group.position.y;
            nodes
                .filter((node) => node.metadata?.groupId === group.id && !positions.has(node.id))
                .forEach((node) => positions.set(node.id, { x: node.position.x + dx, y: node.position.y + dy }));
        });
    targets
        .filter((node) => node.metadata?.isBatchRoot || (node.metadata?.batchChildIds?.length ?? 0) > 0)
        .forEach((root) => {
            const target = positions.get(root.id);
            if (!target) return;
            const dx = target.x - root.position.x;
            const dy = target.y - root.position.y;
            if (!dx && !dy) return;
            const declared = new Set(root.metadata?.batchChildIds || []);
            nodes
                .filter((node) => !positions.has(node.id) && (declared.has(node.id) || node.metadata?.batchRootId === root.id))
                .forEach((node) => positions.set(node.id, { x: node.position.x + dx, y: node.position.y + dy }));
        });
    return nodes.map((node) => (positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node));
}
