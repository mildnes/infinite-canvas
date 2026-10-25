"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Cpu } from "lucide-react";
import { DropdownMenu } from "radix-ui";

import { isWorkflowProtocol } from "@/lib/model-channel";
import type { ModelCapabilities } from "@/lib/model-capability";
import { cn } from "@/lib/utils";
import type { WorkflowRef } from "@/lib/workflow-channel";
import { filterModelsByCapability, normalizeLocalChannels, useConfigStore, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    channelId?: string;
    capability?: ModelCapability;
    onChange: (model: string, channelId?: string) => void;
    workflowRef?: WorkflowRef;
    onWorkflowChange?: (ref?: WorkflowRef) => void;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
    side?: "top" | "bottom";
};

type PickerBase = { key: string; channelKey: string; channelId?: string; channelName: string; protocol?: string; baseUrl?: string; modelCapabilities?: ModelCapabilities; modelMap?: Record<string, string> };
type PickerOption = (PickerBase & { model: string }) | (PickerBase & { model: ""; workflowRef: WorkflowRef; label: string });
type PickerChannel = { key: string; name: string; options: PickerOption[] };

function isWorkflowOption(option: PickerOption): option is PickerBase & { model: ""; workflowRef: WorkflowRef; label: string } {
    return "workflowRef" in option;
}

export function ModelPicker({ config, value, channelId, capability, onChange, workflowRef, onWorkflowChange, className, fullWidth = false, placeholder = "选择模型", onMissingConfig, side = "bottom" }: ModelPickerProps) {
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const openedElsewhereRef = useRef(false);
    const token = useUserStore((state) => state.token);
    const userReady = useUserStore((state) => state.isReady);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const workflowEnabled = Boolean(onWorkflowChange && capability && capability !== "text");
    const { options: channelOptions, channels: pickerChannels } = useMemo(() => {
        const channels =
            config.channelMode === "remote"
                ? config.publicChannels.map((channel, index) => ({ key: channel.id || `remote-${index}`, id: channel.id, protocol: channel.protocol, name: channel.name || "云端渠道", baseUrl: channel.baseUrl, models: channel.models, modelMap: channel.modelMap, modelCapabilities: channel.modelCapabilities, workflows: channel.workflows || [] }))
                : normalizeLocalChannels(config).map((channel) => ({ key: channel.id, id: channel.id, protocol: channel.protocol, name: channel.name || "本地渠道", baseUrl: channel.baseUrl, models: channel.models, modelMap: channel.modelMap, modelCapabilities: channel.modelCapabilities, workflows: channel.workflowSummaries || [] }));
        const models = channels.filter((channel) => !isWorkflowProtocol(channel.protocol || "")).flatMap((channel) => (channel.models ?? []).map((model) => ({ key: `${channel.key}::${model}`, channelKey: channel.key, channelId: channel.id, channelName: channel.name, protocol: channel.protocol, baseUrl: channel.baseUrl, modelMap: channel.modelMap, modelCapabilities: channel.modelCapabilities, model })));
        const filtered = capability ? models.filter((item) => filterModelsByCapability([item.model], capability, item.protocol || "", item.modelCapabilities, item.modelMap).length > 0) : models;
        const scope = config.channelMode === "remote" ? "system" : "personal";
        const workflows: PickerOption[] = !workflowEnabled || !token ? [] : channels.flatMap((channel) => isWorkflowProtocol(channel.protocol || "") ? channel.workflows.filter((entry) => entry.enabled && entry.capability === capability && entry.provider === channel.protocol).map((entry) => {
            const ref: WorkflowRef = { scope, channelId: channel.id || "", kind: entry.kind, workflowId: entry.workflowId };
            return { key: `workflow:${JSON.stringify([ref.scope, ref.channelId, ref.kind, ref.workflowId])}`, channelKey: channel.key, channelId: channel.id, channelName: channel.name, protocol: channel.protocol, baseUrl: channel.baseUrl, model: "", workflowRef: ref, label: entry.title || entry.workflowId };
        }) : []);
        const options: PickerOption[] = [...filtered, ...workflows];
        const byChannel = new Map<string, PickerOption[]>();
        for (const option of options) {
            const entries = byChannel.get(option.channelKey) || [];
            entries.push(option);
            byChannel.set(option.channelKey, entries);
        }
        const groups: PickerChannel[] = channels.flatMap((channel) => {
            const entries = byChannel.get(channel.key);
            return entries?.length ? [{ key: channel.key, name: channel.name, options: entries }] : [];
        });
        return { options, channels: groups };
    }, [capability, config, token, workflowEnabled]);
    const modelLabel = (model: string, _option?: unknown) => model;
    const currentOption = useMemo(() => {
        if (workflowRef && workflowEnabled) return channelOptions.find((item) => isWorkflowOption(item) && item.key === `workflow:${JSON.stringify([workflowRef.scope, workflowRef.channelId, workflowRef.kind, workflowRef.workflowId])}`);
        if (!value) return undefined;
        return channelOptions.find((item) => item.model === value && item.channelId === channelId) || channelOptions.find((item) => item.model === value);
    }, [channelId, channelOptions, value, workflowEnabled, workflowRef]);
    const options = channelOptions;
    const emptyRemoteLabel = config.channelMode === "remote" && !options.length
        ? publicSettings === null ? "正在加载系统模型" : "当前分组没有可用的" + (capability === "image" ? "图片" : capability === "video" ? "视频" : capability === "audio" ? "音频" : capability === "text" ? "文本" : "") + "模型"
        : "";
    const current = workflowRef && workflowEnabled
        ? (currentOption && isWorkflowOption(currentOption) ? currentOption.label : "")
        : currentOption
            ? isWorkflowOption(currentOption) ? currentOption.label : currentOption.model
            : config.channelMode !== "remote" ? value || "" : "";
    const currentValue = current && currentOption ? currentOption.key : "";

	useEffect(() => {
		if (workflowRef && workflowEnabled) {
			const workflowOptionsReady = workflowRef.scope === "system"
				? publicSettings !== null
				: config.workflowSyncTouched === true;
			if (token && userReady && workflowOptionsReady && !currentOption && channelOptions.some((item) => !("workflowRef" in item))) {
				onWorkflowChange?.(undefined);
            }
            return;
        }
        if (value && currentOption?.channelId && !("workflowRef" in currentOption) && channelId !== currentOption.channelId) onChange(value, currentOption.channelId);
	}, [channelId, channelOptions, config.workflowSyncTouched, currentOption, onChange, onWorkflowChange, publicSettings, token, userReady, value, workflowEnabled, workflowRef]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) {
                openedElsewhereRef.current = true;
                setOpen(false);
            }
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return (
        <DropdownMenu.Root
            open={open}
            modal={false}
            onOpenChange={(nextOpen) => {
                if (nextOpen && !options.length && config.channelMode === "local") {
                    onMissingConfig?.();
                    return;
                }
                if (nextOpen) {
                    openedElsewhereRef.current = false;
                    window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                }
                setOpen(nextOpen);
            }}
        >
            <DropdownMenu.Trigger
                type="button"
                data-slot="select-trigger"
                className={cn(
                    "canvas-composer-model-picker flex h-8 w-fit max-w-full items-center gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal whitespace-nowrap shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={workflowRef && workflowEnabled && !currentOption ? "工作流已停用、未公开或删除，请重新选择" : current || placeholder}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{workflowRef && workflowEnabled ? current || "工作流已停用、未公开或删除，请重新选择" : modelLabel(current, currentOption) || emptyRemoteLabel || placeholder}</span>
                <ChevronDown className="canvas-select-chevron size-4 shrink-0 text-muted-foreground" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    data-canvas-no-zoom
                    aria-label="选择渠道商"
                    className="z-[1200] max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] w-44 max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-border/70 bg-popover p-1 text-popover-foreground shadow-xl outline-none sm:w-52"
                    align="start"
                    side={side}
                    sideOffset={6}
                    collisionPadding={12}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    onCloseAutoFocus={(event) => {
                        if (openedElsewhereRef.current) event.preventDefault();
                    }}
                >
                    {pickerChannels.length ? (
                        pickerChannels.map((channel) => (
                            <DropdownMenu.Sub key={channel.key}>
                                <DropdownMenu.SubTrigger
                                    aria-label={channel.name}
                                    textValue={channel.name}
                                    className="flex cursor-default items-center gap-2 rounded-lg px-2 py-2 text-sm outline-none select-none data-[highlighted]:bg-accent data-[state=open]:bg-accent"
                                >
                                    <span className="min-w-0 flex-1 truncate" title={channel.name}>{channel.name}</span>
                                    <span className="shrink-0 text-xs text-muted-foreground">{channel.options.length}</span>
                                    {currentOption?.channelKey === channel.key ? <Check className="size-3.5 shrink-0" /> : null}
                                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                </DropdownMenu.SubTrigger>
                                <DropdownMenu.Portal>
                                    <DropdownMenu.SubContent
                                        data-canvas-no-zoom
                                        aria-label={`${channel.name}的模型`}
                                        className="z-[1201] max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] w-80 max-w-[min(calc(100vw-24px),var(--radix-dropdown-menu-content-available-width))] overflow-y-auto rounded-xl border border-border/70 bg-popover p-1 text-popover-foreground shadow-xl outline-none"
                                        sideOffset={4}
                                        collisionPadding={12}
                                        onPointerDown={(event) => event.stopPropagation()}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onClick={(event) => event.stopPropagation()}
                                        onKeyDown={(event) => event.stopPropagation()}
                                    >
                                        <DropdownMenu.RadioGroup value={currentValue} onValueChange={(nextValue) => {
                                            const option = channel.options.find((item) => item.key === nextValue);
                                            if (!option) return;
                                            if (isWorkflowOption(option)) onWorkflowChange?.(option.workflowRef);
                                            else { onChange(option.model, option.channelId); if (workflowRef) onWorkflowChange?.(undefined); }
                                        }}>
                                            {channel.options.map((option) => (
                                                <DropdownMenu.RadioItem
                                                    key={option.key}
                                                    value={option.key}
                                                    data-model={option.model}
                                                    textValue={isWorkflowOption(option) ? option.label : option.model}
                                                    className="relative flex cursor-default items-center rounded-lg py-2 pr-2 pl-8 text-sm outline-none select-none data-[highlighted]:bg-accent data-[state=checked]:bg-accent/60"
                                                >
                                                    <DropdownMenu.ItemIndicator className="absolute left-2 flex items-center"><Check className="size-3.5" /></DropdownMenu.ItemIndicator>
                                                    <ModelLabel model={isWorkflowOption(option) ? option.workflowRef.workflowId : option.model} label={isWorkflowOption(option) ? `工作流 · ${option.label}` : modelLabel(option.model, option)} />
                                                </DropdownMenu.RadioItem>
                                            ))}
                                        </DropdownMenu.RadioGroup>
                                    </DropdownMenu.SubContent>
                                </DropdownMenu.Portal>
                            </DropdownMenu.Sub>
                        ))
                    ) : (
                        <DropdownMenu.Item disabled className="px-2 py-2 text-sm text-muted-foreground">
                            {config.channelMode === "remote" ? "暂无可用模型" : "请先到配置里拉取模型列表"}
                        </DropdownMenu.Item>
                    )}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

function ModelLabel({ model, label, channelName }: { model: string; label?: string; channelName?: string }) {
    return (
        <span className="flex min-w-0 flex-1 items-center gap-2">
            <ModelIcon model={model} />
            <span className="min-w-0 break-all whitespace-normal sm:truncate sm:whitespace-nowrap" title={label || model}>{label || model}</span>
            {channelName ? <span className="ml-auto max-w-24 shrink-0 truncate text-xs opacity-50">{channelName}</span> : null}
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(model);
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}
