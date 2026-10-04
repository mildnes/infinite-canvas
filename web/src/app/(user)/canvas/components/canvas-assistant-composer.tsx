"use client";

import { useMemo } from "react";
import { ArrowUp, Bot, Brain, FileText, FolderOpen, ImageIcon, Menu, Music2, Sparkles, Square, Upload, Video, X } from "lucide-react";
import { Button, Dropdown } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasAgentConfig, type CanvasAgentSkillReference, type CanvasAgentSkillSelection, type CanvasAssistantReference } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { isCanvasImageNodeType } from "../utils/canvas-panorama";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasAgentSkillPopover } from "./canvas-agent-skill-popover";

export type CanvasAssistantComposerProps = {
    prompt: string;
    isRunning: boolean;
    references: CanvasAssistantReference[];
    /** 首页等无画布上下文场景可省略，默认空列表 */
    mentionReferences?: CanvasResourceReference[];
    availableReferences?: CanvasResourceReference[];
    pendingReferences?: CanvasResourceReference[];
    skills?: CanvasAgentSkillReference[];
    selectedSkills?: CanvasAgentSkillSelection[];
    onSelectSkill?: (skill: CanvasAgentSkillReference) => void;
    onRemoveSkill?: (id: string, source: CanvasAgentSkillSelection["source"]) => void;
    onSelectLibrarySkill?: (skill: CanvasAgentSkillSelection) => void;
    onRemoveLibrarySkill?: (id: string, source: CanvasAgentSkillSelection["source"]) => void;
    agentConfig: CanvasAgentConfig;
    onAgentConfigChange: (patch: Partial<CanvasAgentConfig>) => void;
    onPromptChange: (prompt: string) => void;
    onReferenceIdsChange?: (ids: string[]) => void;
    onSubmit: (prompt?: string, referenceIds?: string[]) => void | Promise<void>;
    onStop?: () => void;
    onOpenUpload: () => void;
    onOpenAssets: () => void;
    onRemoveReference?: (id: string) => void;
    onPasteImage: (file: File) => void;
};

export function CanvasAssistantComposer({
    prompt,
    isRunning,
    references,
    mentionReferences = [],
    availableReferences,
    pendingReferences = [],
    skills = [],
    selectedSkills = [],
    onSelectSkill,
    onRemoveSkill,
    onSelectLibrarySkill,
    onRemoveLibrarySkill,
    agentConfig,
    onAgentConfigChange,
    onPromptChange,
    onReferenceIdsChange,
    onSubmit,
    onStop,
    onOpenUpload,
    onOpenAssets,
    onRemoveReference,
    onPasteImage,
}: CanvasAssistantComposerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const effectiveConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const selectedImageModel = agentConfig.imageModel || effectiveConfig.imageModel;
    const selectedImageChannelId = agentConfig.imageChannelId || effectiveConfig.imageChannelId;
    const imageConfig = useMemo(
        () => ({ ...effectiveConfig, model: selectedImageModel, imageModel: selectedImageModel, imageChannelId: selectedImageChannelId, imageOutputFormat: agentConfig.imageOutputFormat || effectiveConfig.imageOutputFormat || "auto", quality: agentConfig.imageQuality, size: agentConfig.imageSize }),
        [agentConfig.imageOutputFormat, agentConfig.imageQuality, agentConfig.imageSize, effectiveConfig, selectedImageChannelId, selectedImageModel],
    );
    const videoConfig = useMemo(() => ({ ...effectiveConfig, vquality: agentConfig.videoQuality, size: agentConfig.videoSize }), [agentConfig.videoQuality, agentConfig.videoSize, effectiveConfig]);
    const reasoningEnabled = agentConfig.textReasoningEnabled === true;
    const promptReferences = useMemo(() => {
        const seen = new Set<string>();
        return [...(availableReferences || mentionReferences), ...references.map(assistantToPromptReference)].filter((reference) => {
            if (seen.has(reference.nodeId)) return false;
            seen.add(reference.nodeId);
            return true;
        });
    }, [availableReferences, mentionReferences, references]);
    const submitReferenceIds = useMemo(
        () => Array.from(new Set([...references.map((reference) => reference.id), ...pendingReferences.map((reference) => reference.nodeId)])),
        [pendingReferences, references],
    );
    const submit = (nextPrompt = prompt, referenceIds = submitReferenceIds) => onSubmit(nextPrompt, referenceIds);

    return (
        <div className="px-2 pb-2" onWheelCapture={(event) => event.stopPropagation()}>
            {references.length ? (
                <div className="thin-scrollbar mb-1.5 flex max-w-full gap-1.5 overflow-x-auto px-1 pb-1">
                    {references.map((item) => (
                        <AssistantReferenceChip key={item.id} item={item} onRemove={() => onRemoveReference?.(item.id)} />
                    ))}
                </div>
            ) : null}
            {selectedSkills.length ? (
                <div className="thin-scrollbar mb-1.5 flex max-w-full gap-1.5 overflow-x-auto px-1 pb-1">
                    {selectedSkills.map((skill) => (
                        <div
                            key={`${skill.source}:${skill.id}`}
                            className="group/skill inline-flex h-8 max-w-[190px] shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs"
                            style={{ color: theme.node.text, background: theme.toolbar.panel, borderColor: theme.node.stroke }}
                        >
                            <Sparkles className="size-3.5 shrink-0" />
                            <span className="truncate">{skill.name}</span>
                            <button type="button" className="grid size-4 shrink-0 place-items-center rounded-full opacity-60 hover:opacity-100" onClick={() => onRemoveSkill?.(skill.id, skill.source)} aria-label={`移除技能 ${skill.name}`}>
                                <X className="size-3" />
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
            <div className="rounded-2xl border px-3 pb-3 pt-3" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>
                <CanvasPromptChipInput
                    value={prompt}
                    references={promptReferences}
                    pendingReferences={pendingReferences}
                    skills={skills}
                    onSelectSkill={onSelectSkill}
                    onChange={onPromptChange}
                    onReferenceIdsChange={onReferenceIdsChange}
                    onSubmit={(nextPrompt, referenceIds) => void submit(nextPrompt, referenceIds)}
                    onPasteImage={onPasteImage}
                    className="thin-scrollbar h-20 w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-5"
                    style={{ color: theme.node.text }}
                    placeholder="输入 / 使用技能，@ 引用画布素材"
                />
                <div className="mt-2 flex items-end justify-between gap-2">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                        <Dropdown
                            trigger={["click"]}
                            menu={{
                                items: [
                                    { key: "upload", icon: <Upload className="size-4" />, label: "上传文件" },
                                    { key: "assets", icon: <FolderOpen className="size-4" />, label: "我的素材" },
                                ],
                                onClick: ({ key }) => (key === "upload" ? onOpenUpload() : onOpenAssets()),
                            }}
                        >
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={{ color: theme.node.text }} icon={<Menu className="size-4" />} aria-label="添加素材" />
                        </Dropdown>
                        {onSelectLibrarySkill && onRemoveLibrarySkill ? <CanvasAgentSkillPopover selectedSkills={selectedSkills} onSelect={onSelectLibrarySkill} onDeleteSelected={onRemoveLibrarySkill} /> : null}
                        <CanvasImageSettingsPopover
                            config={imageConfig}
                            placement="topLeft"
                            showCount={false}
                            buttonIcon={<ImageIcon className="size-3.5" />}
                            buttonClassName="!h-8 !max-w-[116px] !justify-start !rounded-full !px-2.5"
                            onConfigChange={(key, value) => {
                                if (key === "quality") onAgentConfigChange({ imageQuality: value });
                                else if (key === "size") onAgentConfigChange({ imageSize: value });
                                else if (key === "imageOutputFormat") onAgentConfigChange({ imageOutputFormat: value as CanvasAgentConfig["imageOutputFormat"] });
                            }}
                        />
                        <CanvasVideoSettingsPopover
                            config={videoConfig}
                            placement="topLeft"
                            visualOnly
                            buttonIcon={<Video className="size-3.5" />}
                            buttonClassName="!h-8 !max-w-[124px] !justify-start !rounded-full !px-2.5"
                            onConfigChange={(key, value) => {
                                if (key === "vquality") onAgentConfigChange({ videoQuality: value });
                                else if (key === "size") onAgentConfigChange({ videoSize: value });
                            }}
                        />
                        <ModelPicker
                            config={effectiveConfig}
                            value={selectedImageModel}
                            channelId={selectedImageChannelId}
                            capability="image"
                            side="top"
                            placeholder="图片模型"
                            className="!h-8 !w-[148px] !min-w-[112px] !max-w-[148px] !shrink-0 !rounded-full !px-2.5 !shadow-none"
                            onMissingConfig={() => openConfigDialog(false)}
                            onChange={(imageModel, imageChannelId) => onAgentConfigChange({ imageModel, imageChannelId: imageChannelId || "" })}
                        />
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <Button
                            type="text"
                            shape="circle"
                            className="!h-8 !w-8 !min-w-8"
                            style={{ color: theme.node.text, background: reasoningEnabled ? theme.toolbar.activeBg : undefined }}
                            icon={<Brain className="size-4" />}
                            title={reasoningEnabled ? "推理已开启" : "推理已关闭"}
                            aria-label={reasoningEnabled ? "关闭推理" : "开启推理"}
                            aria-pressed={reasoningEnabled}
                            onClick={() => onAgentConfigChange({ textReasoningEnabled: !reasoningEnabled })}
                        />
                        <Button
                            type="primary"
                            shape="circle"
                            className="!size-10 !min-w-10"
                            disabled={!isRunning && !prompt.trim()}
                            onClick={() => (isRunning ? onStop?.() : void submit())}
                            aria-label={isRunning ? "停止" : "发送"}
                            icon={isRunning ? <Square className="size-4 fill-current" /> : <ArrowUp className="size-4" />}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

export function AssistantReferenceChip({ item, onRemove }: { item: CanvasAssistantReference; onRemove?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div className="group/chip relative inline-flex h-8 max-w-[160px] shrink-0 items-center gap-1.5 rounded-lg text-sm" style={{ color: theme.node.text }}>
            <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg border" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
                {item.dataUrl ? <img src={item.dataUrl} alt="" className="size-8 object-cover" /> : <ReferenceIcon type={item.type} />}
            </span>
            <span className="max-w-[112px] truncate text-xs">{item.title}</span>
            {onRemove ? (
                <button
                    type="button"
                    className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full border opacity-0 transition group-hover/chip:opacity-100"
                    style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}
                    onClick={onRemove}
                    aria-label="移除引用"
                >
                    <X className="size-3" />
                </button>
            ) : null}
        </div>
    );
}

export function assistantToPromptReference(reference: CanvasAssistantReference): CanvasResourceReference {
    const kind = reference.type === CanvasNodeType.Video ? "video" : reference.type === CanvasNodeType.Audio ? "audio" : reference.type === CanvasNodeType.Text ? "text" : "image";
    return {
        id: reference.id,
        nodeId: reference.id,
        kind,
        label: reference.label || reference.title,
        title: reference.title,
        previewUrl: reference.dataUrl || reference.url,
        text: reference.text,
        active: true,
    };
}

function ReferenceIcon({ type }: { type: CanvasNodeType }) {
    if (type === CanvasNodeType.Video) return <Video className="size-4" />;
    if (type === CanvasNodeType.Audio) return <Music2 className="size-4" />;
    if (type === CanvasNodeType.Text) return <FileText className="size-4" />;
    if (isCanvasImageNodeType(type)) return <ImageIcon className="size-4" />;
    return <Bot className="size-4" />;
}
