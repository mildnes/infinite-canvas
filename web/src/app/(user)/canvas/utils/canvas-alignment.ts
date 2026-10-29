import type { CanvasNodeData, Position } from "../types";
import { getNodeBounds } from "./canvas-group";

export type CanvasAlignmentGuides = {
    vertical?: number;
    horizontal?: number;
};

export type CanvasAlignmentContext = {
    movingBounds: ReturnType<typeof getNodeBounds>;
    targets: Array<{
        x: [number, number, number];
        y: [number, number, number];
    }>;
};

export function createCanvasAlignmentContext(nodes: CanvasNodeData[], movingIds: Set<string>): CanvasAlignmentContext | null {
    const movingNodes = nodes.filter((node) => movingIds.has(node.id));
    if (!movingNodes.length) return null;

    return {
        movingBounds: getNodeBounds(movingNodes),
        targets: nodes
            .filter((node) => !movingIds.has(node.id))
            .map((node) => ({
                x: [node.position.x, node.position.x + node.width / 2, node.position.x + node.width],
                y: [node.position.y, node.position.y + node.height / 2, node.position.y + node.height],
            })),
    };
}

export function calculateCanvasAlignment(context: CanvasAlignmentContext | null, rawOffset: Position, threshold: number) {
    if (!context) return { offset: rawOffset, guides: {} as CanvasAlignmentGuides };

    const { left, top, right, bottom } = context.movingBounds;
    const movingX = [left + rawOffset.x, (left + right) / 2 + rawOffset.x, right + rawOffset.x];
    const movingY = [top + rawOffset.y, (top + bottom) / 2 + rawOffset.y, bottom + rawOffset.y];
    let bestXDelta: number | undefined;
    let bestXGuide: number | undefined;
    let bestYDelta: number | undefined;
    let bestYGuide: number | undefined;

    context.targets.forEach((target) => {
        movingX.forEach((value, index) => {
            const delta = target.x[index] - value;
            if (Math.abs(delta) <= threshold && (bestXDelta === undefined || Math.abs(delta) < Math.abs(bestXDelta))) {
                bestXDelta = delta;
                bestXGuide = target.x[index];
            }
        });
        movingY.forEach((value, index) => {
            const delta = target.y[index] - value;
            if (Math.abs(delta) <= threshold && (bestYDelta === undefined || Math.abs(delta) < Math.abs(bestYDelta))) {
                bestYDelta = delta;
                bestYGuide = target.y[index];
            }
        });
    });

    const guides: CanvasAlignmentGuides = {};
    if (bestXGuide !== undefined) guides.vertical = bestXGuide;
    if (bestYGuide !== undefined) guides.horizontal = bestYGuide;

    return {
        offset: {
            x: rawOffset.x + (bestXDelta ?? 0),
            y: rawOffset.y + (bestYDelta ?? 0),
        },
        guides,
    };
}
