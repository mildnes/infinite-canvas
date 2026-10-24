import type { CanvasConnection, CanvasNodeData } from "../types";

/**
 * Metadata fields that change on every generation poll but carry no state worth persisting.
 * Anything else (status, ids, content, error, ...) must stay part of the signature so that
 * task transitions are still saved.
 */
const EPHEMERAL_NODE_METADATA_KEYS = ["progress", "progressText", "elapsedMs", "updatedMs"];

type CanvasPersistState = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions?: unknown[];
    activeChatId?: string | null;
    agentConfig?: unknown;
    backgroundMode?: string;
    showImageInfo?: boolean;
    showConnections?: boolean;
    snapToGrid?: boolean;
    viewport?: { x: number; y: number; k: number };
};

function contentFingerprint(content: unknown): string {
    if (typeof content !== "string" || !content) return "";
    // Inline data URLs can be megabytes; length plus both ends is enough to detect a new payload.
    if (content.length <= 512) return content;
    return `${content.length}:${content.slice(0, 96)}:${content.slice(-96)}`;
}

function metadataFingerprint(metadata: Record<string, unknown> | undefined): string {
    if (!metadata) return "";
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(metadata).sort()) {
        if (EPHEMERAL_NODE_METADATA_KEYS.includes(key)) continue;
        const value = metadata[key];
        rest[key] = typeof value === "string" && value.length > 512 ? contentFingerprint(value) : value;
    }
    return JSON.stringify(rest);
}

/**
 * A cheap, deterministic description of everything that must survive a reload.
 * Two states with the same signature are equivalent for persistence, so poll-driven
 * progress ticks must not trigger a whole-canvas save.
 */
export function canvasPersistSignature(state: CanvasPersistState): string {
    const nodes = (state.nodes || []).map((node) => [
        node.id,
        node.type,
        node.title ?? "",
        node.position?.x,
        node.position?.y,
        node.width,
        node.height,
        metadataFingerprint(node.metadata as Record<string, unknown> | undefined),
    ]);
    const connections = (state.connections || []).map((connection) => [connection.id, connection.fromNodeId, connection.toNodeId]);
    return JSON.stringify({
        n: nodes,
        c: connections,
        s: (state.chatSessions || []).map((session) => {
            const value = session as { id?: string; messages?: unknown[] };
            return [value.id, value.messages?.length, contentFingerprint(JSON.stringify(value.messages || []))];
        }),
        a: state.activeChatId ?? null,
        g: state.agentConfig ?? null,
        b: state.backgroundMode ?? null,
        i: Boolean(state.showImageInfo),
        v: state.showConnections !== false,
        z: Boolean(state.snapToGrid),
    });
}
