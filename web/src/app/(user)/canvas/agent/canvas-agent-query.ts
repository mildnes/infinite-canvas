import type { CanvasAgentContext } from "./canvas-agent-context";
import type { CanvasAgentToolResult } from "./canvas-agent-tools";

export function queryCanvasNodes(context: CanvasAgentContext, args: Record<string, unknown>): CanvasAgentToolResult {
    const nodeId = typeof args.nodeId === "string" ? args.nodeId.trim().toLowerCase() : "";
    const keyword = typeof args.keyword === "string" ? args.keyword.trim().toLowerCase() : "";
    const type = typeof args.type === "string" ? args.type.trim() : "";
    const page = typeof args.page === "number" ? Math.max(1, Math.floor(args.page)) : 1;
    const pageSize = typeof args.pageSize === "number" ? Math.min(50, Math.max(1, Math.floor(args.pageSize))) : 20;
    const matches = context.nodes.filter((node) => {
        if (nodeId && !node.id.toLowerCase().includes(nodeId)) return false;
        if (type && node.type !== type) return false;
        if (keyword && ![node.id, node.title, node.text, node.prompt].filter(Boolean).join(" ").toLowerCase().includes(keyword)) return false;
        return true;
    });
    const start = (page - 1) * pageSize;
    return { ok: true, page, pageSize, total: matches.length, nodes: matches.slice(start, start + pageSize) };
}
