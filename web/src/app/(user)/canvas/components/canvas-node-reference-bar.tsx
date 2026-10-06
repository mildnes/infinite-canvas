"use client";

import { previewSrcFor, fallbackCanvasPreview } from "../utils/canvas-image-preview";

import { FileText, Image as ImageIcon, Music2, Plus, Video, X } from "lucide-react";
import { Popover } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasResourceKind, CanvasResourceReference } from "../utils/canvas-resource-references";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { isCanvasImageNodeType } from "../utils/canvas-panorama";

export function CanvasNodeReferenceBar({
    nodeId,
    connectedNodes,
    onDisconnect,
    onStartSelection,
}: {
    nodeId: string;
    connectedNodes: CanvasNodeData[];
    onDisconnect?: (fromNodeId: string, toNodeId: string) => void;
    onStartSelection?: (nodeId: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const references = buildReferences(connectedNodes);
    return (
        <div className="mb-2">
            <div className="mb-1.5 text-[11px] font-medium" style={{ color: theme.node.muted }}>
                参考内容
            </div>
            <div className="thin-scrollbar flex min-h-12 gap-2 overflow-x-auto pb-1">
                {references.map((reference) => (
                    <ReferenceItem key={reference.id} reference={reference} onRemove={() => onDisconnect?.(reference.nodeId, nodeId)} />
                ))}
                <button
                    type="button"
                    className="grid size-12 shrink-0 place-items-center rounded-xl border bg-transparent transition hover:opacity-70"
                    style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}
                    title="从画布选择参考节点"
                    onClick={() => onStartSelection?.(nodeId)}
                >
                    <Plus className="size-4" />
                </button>
            </div>
        </div>
    );
}

function ReferenceItem({ reference, onRemove }: { reference: CanvasResourceReference; onRemove: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const Icon = reference.kind === "image" ? ImageIcon : reference.kind === "video" ? Video : reference.kind === "audio" ? Music2 : FileText;
    const isMedia = reference.kind === "image" || reference.kind === "video";
    return (
        <Popover
            placement="topLeft"
            mouseEnterDelay={0.15}
            content={<ReferencePreview reference={reference} />}
            arrow={!isMedia}
            destroyOnHidden={reference.kind === "video"}
            styles={isMedia ? { container: { padding: 0, background: "transparent", boxShadow: "none" } } : undefined}
        >
            <div className="group relative grid size-12 shrink-0 place-items-center rounded-xl border" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border }}>
                <span className="grid size-full place-items-center overflow-hidden rounded-[inherit]">
                    {reference.kind === "image" && reference.previewUrl ? (
                        <img src={previewSrcFor(reference.previewUrl, reference.storageKey)} onError={(event) => fallbackCanvasPreview(event.currentTarget, reference.previewUrl!)} loading="lazy" decoding="async" alt="" className="size-full object-cover" />
                    ) : reference.kind === "video" && reference.previewUrl ? (
                        <video src={reference.previewUrl} className="size-full object-cover" muted />
                    ) : (
                        <Icon className="size-4 opacity-65" />
                    )}
                </span>
                <button
                    type="button"
                    className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
                    aria-label="断开参考连接"
                    title="断开参考连接"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        onRemove();
                    }}
                >
                    <X className="size-3" />
                </button>
            </div>
        </Popover>
    );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={previewSrcFor(reference.previewUrl, reference.storageKey)} onError={(event) => fallbackCanvasPreview(event.currentTarget, reference.previewUrl!)} loading="lazy" decoding="async" alt={reference.title} className="block max-h-52 max-w-72 rounded-lg object-contain" />;
    if (reference.kind === "video" && reference.previewUrl) return <video src={reference.previewUrl} className="block max-h-52 max-w-72 rounded-lg" autoPlay muted playsInline preload="metadata" />;
    if (reference.kind === "audio" && reference.previewUrl) return <audio src={reference.previewUrl} className="w-72" controls />;
    return <div className="max-h-52 w-72 overflow-auto whitespace-pre-wrap text-sm">{reference.text || reference.title || "暂无内容"}</div>;
}

function buildReferences(nodes: CanvasNodeData[]) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const kind = referenceKind(node);
        if (!kind) return [];
        const index = ++counts[kind];
        const label = kind === "image" ? imageReferenceLabel(index - 1) : kind === "video" ? seedanceReferenceLabel("video", index - 1) : kind === "audio" ? seedanceReferenceLabel("audio", index - 1) : `文本${index}`;
        return [{ id: node.id, nodeId: node.id, kind, label, title: node.title || label, previewUrl: node.metadata?.content, storageKey: node.metadata?.storageKey, text: node.type === CanvasNodeType.Text ? node.metadata?.content || node.metadata?.prompt : undefined, active: true }];
    });
}

function referenceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (isCanvasImageNodeType(node.type) && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    return null;
}
