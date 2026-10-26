"use client";

import { previewSrcFor, fallbackCanvasPreview } from "../utils/canvas-image-preview";

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Clapperboard, Copy, Group, History, Image as ImageIcon, Music2, PanelRightClose, Plus, RotateCcw, Settings2, Sparkles, Trash2, Type, Video, X } from "lucide-react";
import { App, Button, Modal, Segmented, Switch, Tooltip } from "antd";
import { motion } from "motion/react";
import { nanoid } from "nanoid";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { ImageGenerationPending } from "@/components/image-generation-pending";
import { useCopyText } from "@/hooks/use-copy-text";
import { canvasThemes } from "@/lib/canvas-theme";
import { cn } from "@/lib/utils";
import { fetchAgentSettings } from "@/services/api/agent";
import { imageToDataUrl } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { BUILTIN_CANVAS_AGENT_SKILLS } from "../agent/canvas-agent-skills";
import { createCanvasAgentState, runCanvasAgent } from "../agent/canvas-agent-runtime";
import { MAX_CANVAS_AGENT_SKILLS, type CanvasAgentConfigCompat, type CanvasAgentSkillSelection, type CanvasAssistantSessionCompat } from "../agent/canvas-agent-compat";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasAgentContext } from "../agent/canvas-agent-context";
import type { CanvasAgentAction, CanvasAgentToolResult } from "../agent/canvas-agent-tools";
import { CanvasNodeType, type CanvasAgentConfig, type CanvasAgentSkillReference, type CanvasAgentState, type CanvasAssistantMessage, type CanvasAssistantReference, type CanvasAssistantSession, type CanvasNodeData } from "../types";
import { isCanvasImageNodeType } from "../utils/canvas-panorama";
import { assistantReferenceContentFromNode, buildAgentResourceReferences, buildAllCanvasResourceReferences, type CanvasResourceReference } from "../utils/canvas-resource-references";
import { AssistantReferenceChip, CanvasAssistantComposer } from "./canvas-assistant-composer";

const PANEL_MOTION_MS = 500;
const PANEL_MOTION_SECONDS = PANEL_MOTION_MS / 1000;
const ASSISTANT_NODE_TYPE_META = {
    [CanvasNodeType.Image]: { Icon: ImageIcon, label: "图片" },
    [CanvasNodeType.Panorama]: { Icon: ImageIcon, label: "全景图" },
    [CanvasNodeType.Video]: { Icon: Video, label: "视频" },
    [CanvasNodeType.Audio]: { Icon: Music2, label: "音频" },
    [CanvasNodeType.Text]: { Icon: Type, label: "文本" },
    [CanvasNodeType.Config]: { Icon: Settings2, label: "生成配置" },
    [CanvasNodeType.Director]: { Icon: Clapperboard, label: "导演台" },
    [CanvasNodeType.Group]: { Icon: Group, label: "组" },
};
const ASSISTANT_NODE_STATUS_COLOR: Record<string, string> = {
    success: "#22c55e",
    loading: "#f59e0b",
    error: "#ef4444",
};

type CanvasAssistantPanelProps = {
    readOnly?: boolean;
    canWrite?: () => boolean;
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    referenceNodeClick: { nodeId: string | null; version: number };
    sessions: CanvasAssistantSession[];
    activeSessionId: string | null;
    agentConfig: CanvasAgentConfig;
    width: number;
    onWidthChange: (width: number) => void;
    onFocusNode: (nodeId: string) => void;
    onSelectNodeIds: (ids: Set<string>) => void;
    onSessionsChange: (sessions: CanvasAssistantSession[], activeSessionId: string | null) => void;
    onAgentConfigChange: (patch: Partial<CanvasAgentConfig>) => void;
    onPasteImage: (file: File) => void;
    onOpenUpload: () => void;
    onOpenAssets: () => void;
    getAgentContext: (state: CanvasAgentState) => CanvasAgentContext;
    onExecuteAction: (action: CanvasAgentAction, messageReferenceNodeIds: string[]) => Promise<CanvasAgentToolResult>;
    onCollapseStart: () => void;
    onCollapse: () => void;
    initialRequest?: { prompt: string; references: CanvasAssistantReference[]; skills?: CanvasAgentSkillSelection[] } | null;
    onInitialRequestConsumed?: () => void;
};

type PendingDeleteConfirmation = {
    title: string;
    resolve: (confirmed: boolean) => void;
};

export function CanvasAssistantPanel({
    readOnly = false,
    canWrite,
    nodes,
    selectedNodeIds,
    referenceNodeClick,
    sessions,
    activeSessionId,
    agentConfig,
    width,
    onWidthChange,
    onFocusNode,
    onSelectNodeIds,
    onSessionsChange,
    onAgentConfigChange,
    onPasteImage,
    onOpenUpload,
    onOpenAssets,
    getAgentContext,
    onExecuteAction,
    onCollapseStart,
    onCollapse,
    initialRequest,
    onInitialRequestConsumed,
}: CanvasAssistantPanelProps) {
    const authToken = useUserStore((state) => state.token);
    const authUserId = useUserStore((state) => state.user?.id || "");
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const { message: appMessage } = App.useApp();
    const abortRef = useRef<AbortController | null>(null);
    const accountSessionRef = useRef({ token: authToken, userId: authUserId });
    const consumedInitialRequestRef = useRef<typeof initialRequest>(null);
    const consumedReferenceNodeClickVersionRef = useRef(0);
    const pendingDeleteRef = useRef<PendingDeleteConfirmation | null>(null);
    const messageListRef = useRef<HTMLDivElement>(null);
    const [view, setView] = useState<"chat" | "history">("chat");
    const [prompt, setPrompt] = useState("");
    const [selectedSkills, setSelectedSkills] = useState<CanvasAgentSkillSelection[]>([]);
    const [adminSkills, setAdminSkills] = useState<CanvasAgentSkillReference[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [composerReferenceIds, setComposerReferenceIds] = useState<string[]>([]);
    const [checkedChatIds, setCheckedChatIds] = useState<string[]>([]);
    const [deleteChatIds, setDeleteChatIds] = useState<string[]>([]);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [closing, setClosing] = useState(false);
    const [resizing, setResizing] = useState(false);
    const [removedReferenceIds, setRemovedReferenceIds] = useState<Set<string>>(new Set());
    const [pendingDelete, setPendingDelete] = useState<PendingDeleteConfirmation | null>(null);
    const [initialSession] = useState(createSession);
    const safeSessions = sessions.length ? sessions : [initialSession];
    const resolvedActiveSessionId = activeSessionId && safeSessions.some((session) => session.id === activeSessionId) ? activeSessionId : safeSessions[0]?.id || null;
    const sessionsRef = useRef<CanvasAssistantSession[]>(safeSessions);
    const activeSessionIdRef = useRef<string | null>(resolvedActiveSessionId);

    useEffect(() => {
        if (!readOnly) return;
        abortRef.current?.abort();
        pendingDeleteRef.current?.resolve(false);
        pendingDeleteRef.current = null;
        setPendingDelete(null);
        setIsRunning(false);
    }, [readOnly]);

    useEffect(() => {
        sessionsRef.current = safeSessions;
        activeSessionIdRef.current = resolvedActiveSessionId;
    }, [resolvedActiveSessionId, sessions]);

    useEffect(
        () => () => {
            abortRef.current?.abort();
            pendingDeleteRef.current?.resolve(false);
            pendingDeleteRef.current = null;
        },
        [],
    );

    useEffect(() => {
        const previous = accountSessionRef.current;
        if (previous.token !== authToken || previous.userId !== authUserId) {
            abortRef.current?.abort();
            pendingDeleteRef.current?.resolve(false);
            pendingDeleteRef.current = null;
            setPendingDelete(null);
        }
        accountSessionRef.current = { token: authToken, userId: authUserId };
    }, [authToken, authUserId]);

    const activeSession = safeSessions.find((session) => session.id === resolvedActiveSessionId) || safeSessions[0] || null;
    const historySessions = safeSessions.filter((session) => session.messages.length > 0);
    const messages = activeSession?.messages || [];
    const hasMessages = messages.length > 0;
    const selectedNodeKey = useMemo(() => Array.from(selectedNodeIds).sort().join(","), [selectedNodeIds]);
    useEffect(() => {
        if (view !== "chat") return;
        const frame = window.requestAnimationFrame(() => {
            const element = messageListRef.current;
            if (element) element.scrollTop = element.scrollHeight;
        });
        return () => window.cancelAnimationFrame(frame);
    }, [messages, view]);
    useEffect(() => {
        let cancelled = false;
        if (!authToken) {
            setAdminSkills([]);
            return;
        }
        void fetchAgentSettings(authToken)
            .then((settings) => {
                if (cancelled) return;
                setAdminSkills(settings.skills.filter((skill) => skill.enabled).map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, source: "admin" as const })));
            })
            .catch(() => {
                if (!cancelled) setAdminSkills([]);
            });
        return () => {
            cancelled = true;
        };
    }, [authToken]);
    const resourceReferences = useMemo(() => buildAllCanvasResourceReferences(nodes), [nodes]);
    const resourceReferenceById = useMemo(() => new Map(resourceReferences.map((reference) => [reference.nodeId, reference])), [resourceReferences]);
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const selectedReferenceNodeIds = useMemo(() => {
        const ids: string[] = [];
        const seen = new Set<string>();
        const append = (id: string) => {
            if (!id || seen.has(id)) return;
            seen.add(id);
            ids.push(id);
        };
        selectedNodeIds.forEach((id) => {
            const node = nodeById.get(id);
            if (!node) return;
            if (node.type === CanvasNodeType.Group) {
                nodes.filter((child) => child.metadata?.groupId === node.id).forEach((child) => append(child.id));
                return;
            }
            append(node.id);
            node.metadata?.batchChildIds?.forEach(append);
        });
        return new Set(ids);
    }, [nodeById, nodes, selectedNodeIds]);
    const resolveReferences = useCallback(
        (ids: string[]) => ids.flatMap((id) => {
            const node = nodeById.get(id);
            const resource = resourceReferenceById.get(id);
            const reference = node && resource ? nodeToReference(node, resource) : null;
            return reference ? [reference] : [];
        }),
        [nodeById, resourceReferenceById],
    );
    const composerReferences = useMemo(() => resolveReferences(composerReferenceIds), [composerReferenceIds, resolveReferences]);
    const pendingReferences = useMemo(() => {
        const pendingClickNodeId = referenceNodeClick.version > consumedReferenceNodeClickVersionRef.current ? referenceNodeClick.nodeId : null;
        return resourceReferences.filter(
            (reference) => selectedReferenceNodeIds.has(reference.nodeId)
                && ((!composerReferenceIds.includes(reference.nodeId) && !removedReferenceIds.has(reference.nodeId)) || reference.nodeId === pendingClickNodeId),
        );
    }, [composerReferenceIds, referenceNodeClick, removedReferenceIds, resourceReferences, selectedReferenceNodeIds]);
    const mentionReferences = useMemo(() => buildAgentResourceReferences(nodes), [nodes]);
    const skillOptions = useMemo<CanvasAgentSkillReference[]>(() => [...BUILTIN_CANVAS_AGENT_SKILLS.map(({ prompt: _prompt, ...skill }) => skill), ...adminSkills], [adminSkills]);
    const compatConfig = agentConfig as CanvasAgentConfigCompat;
    const iconButtonStyle = { color: theme.node.muted };
    const settleDeleteConfirmation = (confirmed: boolean) => {
        const pending = pendingDeleteRef.current;
        if (!pending) return;
        pendingDeleteRef.current = null;
        setPendingDelete(null);
        pending.resolve(confirmed);
    };
    const removeComposerReferences = (ids: string[]) => {
        if (!ids.length) return;
        const removeIds = new Set(ids);
        setComposerReferenceIds((current) => current.filter((id) => !removeIds.has(id)));
        setRemovedReferenceIds((previous) => new Set([...previous, ...removeIds]));
    };
    const removeComposerReference = (id: string) => {
        removeComposerReferences([id]);
        if (selectedNodeIds.has(id)) onSelectNodeIds(new Set(Array.from(selectedNodeIds).filter((nodeId) => nodeId !== id)));
    };
    const deselectNodeIds = (ids: string[]) => {
        if (!ids.length || !selectedNodeIds.size) return;
        const removeIds = new Set(ids);
        const nextSelectedIds = new Set(Array.from(selectedNodeIds).filter((id) => !removeIds.has(id)));
        if (nextSelectedIds.size !== selectedNodeIds.size) onSelectNodeIds(nextSelectedIds);
    };

    useEffect(() => {
        setRemovedReferenceIds(new Set());
    }, [selectedNodeKey]);

    const commitSessions = (nextSessions: CanvasAssistantSession[], nextActiveSessionId = activeSessionIdRef.current) => {
        if (readOnly || canWrite?.() === false) { appMessage.warning("本窗口为只读，请先接管编辑"); return; }
        sessionsRef.current = nextSessions;
        activeSessionIdRef.current = nextActiveSessionId;
        onSessionsChange(nextSessions, nextActiveSessionId);
    };

    const updateSession = (sessionId: string, updater: (session: CanvasAssistantSession) => CanvasAssistantSession) => {
        commitSessions(sessionsRef.current.map((session) => (session.id === sessionId ? updater(session) : session)));
    };

    const appendMessage = (sessionId: string, message: CanvasAssistantMessage) => {
        updateSession(sessionId, (session) => ({
            ...session,
            title: session.messages.length ? session.title : message.text.slice(0, 18) || "新对话",
            messages: [...session.messages, message],
            updatedAt: new Date().toISOString(),
        }));
    };

    const updateMessage = (sessionId: string, messageId: string, patch: Partial<CanvasAssistantMessage>) => {
        updateSession(sessionId, (session) => ({
            ...session,
            messages: session.messages.map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
            updatedAt: new Date().toISOString(),
        }));
    };

    const startChatSession = () => {
        if (activeSession && activeSession.messages.length === 0) {
            commitSessions(sessionsRef.current, activeSession.id);
            return;
        }
        const session = createSession();
        commitSessions([session, ...sessionsRef.current], session.id);
    };

    const removeSessions = (ids: string[]) => {
        const next = safeSessions.filter((session) => !ids.includes(session.id));
        if (!next.length) {
            const session = createSession();
            commitSessions([session], session.id);
        } else {
            const currentActiveSessionId = activeSessionIdRef.current;
            commitSessions(next, currentActiveSessionId && ids.includes(currentActiveSessionId) ? next[0].id : currentActiveSessionId);
        }
        cleanupImages({ sessions: next });
        setCheckedChatIds((previous) => previous.filter((id) => !ids.includes(id)));
    };

    const clearSessions = () => {
        const session = createSession();
        commitSessions([session], session.id);
        setCheckedChatIds([]);
        cleanupImages({ sessions: [session] });
    };

    const selectSkill = (skill: CanvasAgentSkillSelection) => {
        setSelectedSkills((current) => {
            const existing = current.findIndex((item) => item.id === skill.id && item.source === skill.source);
            if (existing >= 0) return current.map((item, index) => (index === existing ? skill : item));
            if (current.length >= MAX_CANVAS_AGENT_SKILLS) {
                appMessage.warning(`最多选择 ${MAX_CANVAS_AGENT_SKILLS} 个 Skill`);
                return current;
            }
            return [...current, skill];
        });
    };

    const sendMessage = async (text: string, savedReferences?: CanvasAssistantReference[], savedSkills?: CanvasAgentSkillSelection[]) => {
        const requestToken = authToken;
        const requestUserId = authUserId;
        if (readOnly || canWrite?.() === false) { appMessage.warning("本窗口为只读，请先接管编辑"); return; }
        const requestIsCurrent = () => canWrite?.() !== false && useUserStore.getState().token === requestToken && (useUserStore.getState().user?.id || "") === requestUserId;
        const session = activeSession || createSession();
        if (!activeSession) {
            commitSessions([session], session.id);
        }

        // @ 提及优先；没有明确 @ 时，自动带入画布当前选中的媒体节点。
        const mentionedReferences = savedReferences === undefined ? collectMentionedAssistantReferences(text, nodes, mentionReferences) : [];
        const references = savedReferences !== undefined ? savedReferences : composerReferences.length ? composerReferences : mentionedReferences;
        const skills = savedSkills || selectedSkills;
        const librarySelections = skills.filter((skill) => skill.source === "system" || skill.source === "user");
        let activeSkillContents: Array<{ id: string; source: "system" | "user"; name: string; content: string; hasFiles?: boolean }> = [];
        if (librarySelections.length) {
            try {
                await useAgentSkillStore.getState().loadSkills();
                const available = [...useAgentSkillStore.getState().systemSkills, ...useAgentSkillStore.getState().userSkills];
                activeSkillContents = librarySelections
                    .map((selected) => available.find((skill) => skill.id === selected.id && skill.source === selected.source && skill.enabled))
                    .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
                    .map((skill) => ({ id: skill.id, source: skill.source, name: skill.name, content: skill.content, hasFiles: skill.hasFiles }));
                if (activeSkillContents.length !== librarySelections.length) {
                    if (!requestIsCurrent()) return;
                    appMessage.error("部分 Skill 已不可用，请重新选择");
                    return;
                }
            } catch (error) {
                if (!requestIsCurrent()) return;
                appMessage.error(error instanceof Error ? error.message : "Skill 加载失败");
                return;
            }
        }
        if (!requestIsCurrent()) return;
        const messageReferenceNodeIds = references.map((reference) => reference.id);
        const userMessage = { id: nanoid(), role: "user", text, references, skills, status: "success" } as CanvasAssistantMessage;
        const assistantId = nanoid();
        appendMessage(session.id, userMessage);
        appendMessage(session.id, { id: assistantId, role: "assistant", text: "", status: "thinking", activity: "正在理解画布和创作目标" });
        setPrompt("");
        setComposerReferenceIds([]);
        setSelectedSkills([]);
        setRemovedReferenceIds(new Set(selectedReferenceNodeIds));

        const requestConfig = {
            ...effectiveConfig,
            model: effectiveConfig.textModel || effectiveConfig.model,
            apiMode: compatConfig.textApiMode || "chat",
            textStreaming: compatConfig.textStreaming === true,
            textReasoningEnabled: agentConfig.textReasoningEnabled === true,
            activeChannelId: effectiveConfig.textChannelId || effectiveConfig.activeChannelId,
            textChannelId: effectiveConfig.textChannelId,
        };
        const jsonToolFallbackKey = [requestConfig.apiMode || "chat", requestConfig.textChannelId || requestConfig.activeChannelId || requestConfig.baseUrl, requestConfig.model].join("|");
        if (!isAiConfigReady(requestConfig, requestConfig.model)) {
            if (!requestIsCurrent()) return;
            updateMessage(session.id, assistantId, {
                text: "全局文本模型尚未配置完成。请先从应用原有的全局配置入口选择文本模型和渠道，然后再继续。",
                status: "error",
                activity: undefined,
            });
            return;
        }

        const controller = new AbortController();
        abortRef.current = controller;
        setIsRunning(true);
        try {
            const modelReferences = await Promise.all(
                references.map(async (reference) => {
                    if (!reference.dataUrl) return reference;
                    try {
                        return { ...reference, dataUrl: await imageToDataUrl(reference) };
                    } catch {
                        return reference;
                    }
                }),
            );
            if (!requestIsCurrent()) return;
            const result = await runCanvasAgent({
                config: requestConfig,
                initialState: session.agentState,
                protocolMessages: session.protocolMessages,
                userText: text,
                references: modelReferences,
                skillReferences: skills.filter((skill): skill is CanvasAgentSkillReference => skill.source === "builtin" || skill.source === "admin"),
                activeSkillContents,
                contextCheckpoint: (session as CanvasAssistantSessionCompat).contextCheckpoint,
                preferredJsonMode: session.jsonToolFallbackKey === jsonToolFallbackKey ? session.jsonToolFallbackMode : undefined,
                getContext: getAgentContext,
                executeAction: async (action) => {
                    if (!requestIsCurrent()) return { ok: false, code: "stale_session", message: "账号已切换，已停止执行旧会话操作" };
                    if (action.name !== "delete_node") return onExecuteAction(action, messageReferenceNodeIds);
                    const nodeId = typeof action.arguments.nodeId === "string" ? action.arguments.nodeId : "";
                    const node = nodes.find((item) => item.id === nodeId);
                    const confirmed = await new Promise<boolean>((resolve) => {
                        const pending = { title: node?.title || "未命名节点", resolve };
                        pendingDeleteRef.current = pending;
                        setPendingDelete(pending);
                    });
                    return confirmed ? onExecuteAction(action, messageReferenceNodeIds) : { ok: false, code: "delete_cancelled", message: "用户取消删除，原节点已保留" };
                },
                authToken,
                signal: controller.signal,
                onEvent: (event) => {
                    if (requestIsCurrent()) updateMessage(session.id, assistantId, { status: event.status, activity: event.label });
                },
                onCheckpoint: (checkpoint) =>
                    requestIsCurrent()
                        ? updateSession(
                              session.id,
                              (current) =>
                                  ({
                                      ...current,
                                      agentState: checkpoint.state,
                                      protocolMessages: checkpoint.protocolMessages,
                                      contextCheckpoint: checkpoint.contextCheckpoint,
                                      jsonToolFallbackKey: checkpoint.jsonFallbackMode ? jsonToolFallbackKey : undefined,
                                      jsonToolFallbackMode: checkpoint.jsonFallbackMode,
                                      updatedAt: new Date().toISOString(),
                                  }) as CanvasAssistantSession,
                          )
                        : undefined,
            });
            if (!requestIsCurrent()) return;
            updateSession(
                session.id,
                (current) =>
                    ({
                        ...current,
                        agentState: result.state,
                        protocolMessages: result.protocolMessages,
                        contextCheckpoint: result.contextCheckpoint,
                        jsonToolFallbackKey: result.jsonFallbackMode ? jsonToolFallbackKey : undefined,
                        jsonToolFallbackMode: result.jsonFallbackMode,
                        messages: current.messages.map((message) => (message.id === assistantId ? { ...message, text: result.reply, status: "success", activity: undefined } : message)),
                        updatedAt: new Date().toISOString(),
                    }) as CanvasAssistantSession,
            );
        } catch (error) {
            if (!requestIsCurrent()) return;
            const stopped = error instanceof Error && error.name === "AbortError";
            updateMessage(session.id, assistantId, {
                text: stopped ? "已停止继续执行。已经创建的节点和已经提交的媒体任务会保留。" : error instanceof Error ? error.message : "Agent 执行失败",
                status: stopped ? "waiting" : "error",
                activity: undefined,
            });
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setIsRunning(false);
        }
    };

    useEffect(() => {
        if (readOnly || canWrite?.() === false || !initialRequest || consumedInitialRequestRef.current === initialRequest) return;
        consumedInitialRequestRef.current = initialRequest;
        onInitialRequestConsumed?.();
        void sendMessage(initialRequest.prompt, initialRequest.references, initialRequest.skills);
    }, [initialRequest, onInitialRequestConsumed, readOnly]);

    const submit = async (nextPrompt = prompt, referenceIds = composerReferenceIds) => {
        const text = nextPrompt.trim();
        if (!text || isRunning) return;
        const references = resolveReferences(referenceIds);
        await sendMessage(text, references.length ? references : undefined);
    };

    const retryMessage = (message: CanvasAssistantMessage) => {
        const index = messages.findIndex((item) => item.id === message.id);
        const user = messages.slice(0, index).findLast((item) => item.role === "user");
        if (user) void sendMessage(user.text, user.references, user.skills as CanvasAgentSkillSelection[] | undefined);
    };

    const startResize = () => {
        const move = (event: MouseEvent) => onWidthChange(Math.min(760, Math.max(320, window.innerWidth - event.clientX)));
        const stop = () => {
            setResizing(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", stop);
        };
        setResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", stop);
    };

    const collapse = () => {
        setClosing(true);
        onCollapseStart();
        window.setTimeout(onCollapse, PANEL_MOTION_MS);
    };

    return (
        <motion.div
            className="flex shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: closing ? 0 : width + 1, opacity: closing ? 0 : 1 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: closing ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex shrink-0 flex-col border-l"
                initial={{ x: 48 }}
                animate={{ x: closing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onMouseDown={startResize} aria-label="调整右侧面板宽度" />
                <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex items-center gap-2 text-sm font-medium">
                        <Bot className="size-4" />
                        {view === "history" ? "历史记录" : "创作 Agent"}
                    </div>
                    <div className="flex items-center gap-1">
                        {view === "history" ? (
                            <>
                                <Tooltip title="删除选中">
                                    <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Trash2 className="size-4" />} disabled={!checkedChatIds.length} onClick={() => setDeleteChatIds(checkedChatIds)} />
                                </Tooltip>
                                <Tooltip title="删除全部">
                                    <Button
                                        type="text"
                                        shape="circle"
                                        className="!h-8 !w-8 !min-w-8"
                                        style={iconButtonStyle}
                                        icon={<X className="size-4" />}
                                        disabled={!historySessions.length}
                                        onClick={() => setDeleteChatIds(historySessions.map((session) => session.id))}
                                    />
                                </Tooltip>
                            </>
                        ) : null}
                        <Tooltip title={view === "history" ? "返回对话" : "历史记录"}>
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<History className="size-4" />} onClick={() => setView(view === "history" ? "chat" : "history")} />
                        </Tooltip>
                        {view === "chat" ? (
                            <Tooltip title="Agent 设置">
                                <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Settings2 className="size-4" />} onClick={() => setSettingsOpen(true)} />
                            </Tooltip>
                        ) : null}
                        <Tooltip title="新对话">
                            <Button
                                type="text"
                                shape="circle"
                                className="!h-8 !w-8 !min-w-8"
                                style={iconButtonStyle}
                                icon={<Plus className="size-4" />}
                                disabled={!hasMessages}
                                onClick={() => {
                                    startChatSession();
                                    setView("chat");
                                }}
                            />
                        </Tooltip>
                        <Tooltip title="收起对话">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<PanelRightClose className="size-4" />} onClick={collapse} />
                        </Tooltip>
                    </div>
                </div>

                <div ref={messageListRef} className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                    {view === "history" ? (
                        <AssistantHistory
                            sessions={historySessions}
                            activeSession={activeSession}
                            checkedIds={checkedChatIds.filter((id) => historySessions.some((session) => session.id === id))}
                            onToggleChecked={(id, checked) => setCheckedChatIds((previous) => (checked ? [...new Set([...previous, id])] : previous.filter((item) => item !== id)))}
                            onOpen={(id) => {
                                commitSessions(sessionsRef.current, id);
                                setView("chat");
                            }}
                            onDelete={(id) => setDeleteChatIds([id])}
                        />
                    ) : messages.length ? (
                        <AssistantMessages messages={messages} nodeById={nodeById} onFocusNode={onFocusNode} onRetry={retryMessage} />
                    ) : (
                        <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                            <div className="grid size-12 place-items-center rounded-2xl" style={{ background: theme.node.fill }}>
                                <Sparkles className="size-5" />
                            </div>
                            <div className="mt-4 text-base font-medium">从一个想法开始</div>
                            <div className="mt-2 max-w-[260px] text-sm leading-6 opacity-55">描述故事、宣传片或现有素材，Agent 会与你沟通并直接操作当前画布</div>
                        </div>
                    )}
                </div>

                {view === "chat" ? (
                    <>
                        {pendingDelete ? (
                            <div className="mx-2 mb-2 overflow-hidden rounded-xl border" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
                                <div className="min-w-0 px-3 py-2.5">
                                    <div className="truncate text-sm font-medium">删除「{pendingDelete.title}」？</div>
                                    <div className="mt-0.5 text-xs opacity-55">相关连线和任务记录将按现有逻辑清理</div>
                                </div>
                                <div className="grid grid-cols-2 border-t" style={{ borderColor: theme.node.stroke }}>
                                    <button type="button" className="h-9 cursor-pointer border-0 bg-transparent text-sm" style={{ color: theme.node.text }} onClick={() => settleDeleteConfirmation(false)}>
                                        取消
                                    </button>
                                    <button type="button" className="h-9 cursor-pointer border-0 border-l bg-transparent text-sm font-medium" style={{ borderColor: theme.node.stroke, color: "#ef4444" }} onClick={() => settleDeleteConfirmation(true)}>
                                        确认删除
                                    </button>
                                </div>
                            </div>
                        ) : null}
                        {readOnly ? <p role="status" className="px-4 py-3 text-sm opacity-75">本窗口为只读，可查看对话；接管编辑后可继续使用 Agent。</p> : <CanvasAssistantComposer
                            prompt={prompt}
                            isRunning={isRunning}
                            references={composerReferences}
                            mentionReferences={mentionReferences}
                            availableReferences={resourceReferences}
                            pendingReferences={pendingReferences}
                            skills={skillOptions}
                            selectedSkills={selectedSkills}
                            onSelectSkill={selectSkill}
                            onRemoveSkill={(id, source) => setSelectedSkills((current) => current.filter((skill) => skill.id !== id || skill.source !== source))}
                            onSelectLibrarySkill={selectSkill}
                            onRemoveLibrarySkill={(id, source) => setSelectedSkills((current) => current.filter((skill) => skill.id !== id || skill.source !== source))}
                            agentConfig={agentConfig}
                            onAgentConfigChange={onAgentConfigChange}
                            onPromptChange={setPrompt}
                            onReferenceIdsChange={(ids) => {
                                consumedReferenceNodeClickVersionRef.current = referenceNodeClick.version;
                                const knownReferenceIds = new Set([...composerReferenceIds, ...pendingReferences.map((reference) => reference.nodeId)]);
                                const removedSelectedIds = Array.from(knownReferenceIds).filter((id) => selectedReferenceNodeIds.has(id) && !ids.includes(id));
                                removeComposerReferences(removedSelectedIds);
                                deselectNodeIds(removedSelectedIds);
                                setComposerReferenceIds(ids);
                            }}
                            onSubmit={submit}
                            onStop={() => {
                                settleDeleteConfirmation(false);
                                abortRef.current?.abort();
                            }}
                            onOpenUpload={onOpenUpload}
                            onOpenAssets={onOpenAssets}
                            onRemoveReference={(id) => {
                                removeComposerReference(id);
                            }}
                            onPasteImage={onPasteImage}
                        />}
                    </>
                ) : null}

                <Modal
                    title="Agent 设置"
                    open={settingsOpen}
                    centered
                    width={520}
                    onCancel={() => setSettingsOpen(false)}
                    footer={
                        <Button type="primary" onClick={() => setSettingsOpen(false)}>
                            完成
                        </Button>
                    }
                >
                    <div className="flex items-center justify-between gap-6 py-2">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">文本接口</div>
                            <div className="mt-1 text-xs leading-5 opacity-55">选择使用 Chat Completions 或 Responses 接口</div>
                        </div>
                        <Segmented
                            value={compatConfig.textApiMode || "chat"}
                            options={[{ label: "Chat", value: "chat" }, { label: "Responses", value: "responses" }]}
                            onChange={(textApiMode) => onAgentConfigChange({ textApiMode: textApiMode as CanvasAgentConfig["textApiMode"] })}
                        />
                    </div>
                    <div className="flex items-center justify-between gap-6 py-2">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">流式响应</div>
                            <div className="mt-1 text-xs leading-5 opacity-55">开启后以流式读取文本模型回复</div>
                        </div>
                        <Switch checked={compatConfig.textStreaming === true} onChange={(textStreaming) => onAgentConfigChange({ textStreaming })} />
                    </div>
                    <div className="flex items-center justify-between gap-6 py-2">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">自动生成图片/视频/音频</div>
                            <div className="mt-1 text-xs leading-5 opacity-55">开启后 Agent 可直接提交图片、视频和音频生成，无需再次确认</div>
                        </div>
                        <Switch checked={Boolean(compatConfig.autoGenerateMedia)} onChange={(autoGenerateMedia) => onAgentConfigChange({ autoGenerateMedia } as Partial<CanvasAgentConfig>)} />
                    </div>
                </Modal>

                <Modal
                    title="删除对话记录？"
                    open={deleteChatIds.length > 0}
                    centered
                    onCancel={() => setDeleteChatIds([])}
                    footer={
                        <>
                            <Button onClick={() => setDeleteChatIds([])}>取消</Button>
                            <Button
                                danger
                                type="primary"
                                onClick={() => {
                                    deleteChatIds.length === historySessions.length ? clearSessions() : removeSessions(deleteChatIds);
                                    setDeleteChatIds([]);
                                }}
                            >
                                删除
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">将删除 {deleteChatIds.length} 条对话记录，此操作不可撤销</p>
                </Modal>
            </motion.aside>
        </motion.div>
    );
}

const ASSISTANT_MARKDOWN_COMPONENTS: Components = {
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4" />,
};

function AssistantMarkdown({ children, components }: { children: string; components: Components }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div
            className={cn(
                "min-w-0 whitespace-normal break-words",
                "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
                "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h1:first-child]:mt-0",
                "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2:first-child]:mt-0",
                "[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:font-semibold [&_h3:first-child]:mt-0",
                "[&_h4]:my-2 [&_h4]:font-semibold",
                "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
                "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[color:var(--agent-markdown-border)] [&_blockquote]:pl-3 [&_blockquote]:opacity-80",
                "[&_hr]:my-3 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[color:var(--agent-markdown-border)]",
                "[&_code]:rounded [&_code]:bg-[var(--agent-markdown-surface)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
                "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--agent-markdown-surface)] [&_pre]:p-3",
                "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
                "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_th]:border-b [&_th]:border-[color:var(--agent-markdown-border)] [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_td]:border-b [&_td]:border-[color:var(--agent-markdown-border)] [&_td]:px-2 [&_td]:py-1.5",
            )}
            style={
                {
                    "--agent-markdown-surface": theme.toolbar.itemHover,
                    "--agent-markdown-border": theme.node.stroke,
                } as CSSProperties
            }
        >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
                {children}
            </ReactMarkdown>
        </div>
    );
}

function AssistantMessages({ messages, nodeById, onFocusNode, onRetry }: { messages: CanvasAssistantMessage[]; nodeById: ReadonlyMap<string, CanvasNodeData>; onFocusNode: (nodeId: string) => void; onRetry: (message: CanvasAssistantMessage) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const copyText = useCopyText();
    const markdownComponents = useMemo<Components>(() => ({
        ...ASSISTANT_MARKDOWN_COMPONENTS,
        code: ({ node, className, children, ...props }) => {
            const nodeId = String(children).trim();
            const canvasNode = nodeById.get(nodeId);
            const isInlineCode = node?.position?.start.line === node?.position?.end.line;
            if (isInlineCode && canvasNode) {
                const { Icon, label: typeLabel } = ASSISTANT_NODE_TYPE_META[canvasNode.type];
                const hasImage = isCanvasImageNodeType(canvasNode.type) && Boolean(canvasNode.metadata?.content);
                return (
                    <span className="my-1 flex w-full min-w-0 items-center rounded-lg transition-opacity hover:opacity-80" style={{ background: theme.toolbar.itemHover }}>
                        <button type="button" onClick={() => onFocusNode(canvasNode.id)} className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left outline-none" title={`定位到画布节点：${canvasNode.title || typeLabel}`}>
                            <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md">
                                {hasImage ? <img src={previewSrcFor(canvasNode.metadata?.content || "", canvasNode.metadata?.storageKey)} onError={(event) => fallbackCanvasPreview(event.currentTarget, canvasNode.metadata?.content || "")} loading="lazy" decoding="async" alt={canvasNode.title || typeLabel} className="size-full object-cover" /> : <Icon className="size-5 opacity-60" />}
                            </span>
                            <span className="min-w-0 flex-1 space-y-0.5">
                                <span className="block truncate text-sm font-medium leading-snug">{canvasNode.title || `${typeLabel}节点`}</span>
                                <span className="block truncate text-xs leading-snug opacity-50">{canvasNode.type === CanvasNodeType.Text ? canvasNode.metadata?.content || canvasNode.metadata?.prompt || "" : typeLabel}</span>
                            </span>
                            {canvasNode.metadata?.status && canvasNode.metadata.status !== "idle" ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: ASSISTANT_NODE_STATUS_COLOR[canvasNode.metadata.status] || "transparent" }} /> : null}
                        </button>
                    </span>
                );
            }
            return <code {...props} className={className}>{children}</code>;
        },
    }), [nodeById, onFocusNode, theme]);

    return (
        <>
            {messages.map((message) => {
                const running = message.status === "thinking" || message.status === "running";
                return (
                    <div key={message.id} className={cn("flex flex-col gap-2", message.role === "user" ? "items-end" : "items-start")}>
                        {message.text ? (
                            <div
                                className="max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-6"
                                style={
                                    message.role === "user"
                                        ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText }
                                        : message.status === "error"
                                          ? { background: theme.node.fill, color: theme.node.text }
                                          : { background: theme.node.fill, color: theme.node.text }
                                }
                            >
                                {message.role === "assistant" ? (
                                    <div className="mb-1 flex items-center gap-1.5 text-xs opacity-60">
                                        <Bot className="size-3.5" />
                                        Agent
                                    </div>
                                ) : null}
                                {message.role === "assistant" ? <AssistantMarkdown components={markdownComponents}>{message.text}</AssistantMarkdown> : message.text}
                            </div>
                        ) : null}
                        {message.references?.length ? <MessageReferences message={message} /> : null}
                        {running ? <ImageGenerationPending compact label={message.activity || "正在执行"} className="w-[250px] rounded-2xl border" /> : null}
                        {message.role === "assistant" && !running && message.text ? (
                            <div className="flex items-center gap-1">
                                <Button shape="circle" size="small" style={{ borderColor: theme.node.stroke }} icon={<Copy className="size-3.5" />} onClick={() => copyText(message.text)} title="复制" />
                                <Button shape="circle" size="small" style={{ borderColor: theme.node.stroke }} icon={<RotateCcw className="size-3.5" />} onClick={() => onRetry(message)} title="重试" />
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </>
    );
}

function AssistantHistory({
    sessions,
    activeSession,
    checkedIds,
    onToggleChecked,
    onOpen,
    onDelete,
}: {
    sessions: CanvasAssistantSession[];
    activeSession: CanvasAssistantSession | null;
    checkedIds: string[];
    onToggleChecked: (id: string, checked: boolean) => void;
    onOpen: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div className="space-y-1">
            {sessions.map((session) => (
                <div key={session.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition" style={session.id === activeSession?.id ? { background: theme.node.fill } : undefined}>
                    <input type="checkbox" className="size-4" style={{ accentColor: theme.node.text }} checked={checkedIds.includes(session.id)} onChange={(event) => onToggleChecked(session.id, event.target.checked)} />
                    <button type="button" className="min-w-0 flex-1 text-left text-sm" onClick={() => onOpen(session.id)}>
                        <span className="block truncate">{session.title}</span>
                        <span className="text-xs opacity-50">{session.messages.length} 条消息</span>
                    </button>
                    <Button type="text" shape="circle" size="small" className="opacity-0 transition group-hover:opacity-100" icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(session.id)} title="删除" />
                </div>
            ))}
        </div>
    );
}

function MessageReferences({ message }: { message: CanvasAssistantMessage }) {
    return (
        <div className={cn("flex max-w-[88%] flex-wrap gap-2", message.role === "user" ? "justify-end" : "justify-start")}>
            {message.references?.map((item) => (
                <AssistantReferenceChip key={item.id} item={item} />
            ))}
        </div>
    );
}

function nodeToReference(node: CanvasNodeData, resource?: CanvasResourceReference): CanvasAssistantReference | null {
    const content = assistantReferenceContentFromNode(node);
    return content ? { id: node.id, type: node.type, title: node.title, label: resource?.label, ...content } : null;
}

function collectMentionedAssistantReferences(text: string, nodes: CanvasNodeData[], mentionReferences: ReturnType<typeof buildAgentResourceReferences>) {
    if (!text.trim() || !mentionReferences.length) return [] as CanvasAssistantReference[];
    const labels = mentionReferences.map((item) => item.label).sort((a, b) => b.length - a.length);
    const hitLabels = new Set<string>();
    for (const label of labels) {
        if (!label) continue;
        if (textMentionsLabel(text, label)) hitLabels.add(label);
    }
    if (!hitLabels.size) return [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return mentionReferences
        .filter((item) => hitLabels.has(item.label))
        .map((item) => nodeById.get(item.nodeId))
        .filter((node): node is CanvasNodeData => Boolean(node))
        .map((node) => nodeToReference(node))
        .filter((item): item is CanvasAssistantReference => Boolean(item));
}

function textMentionsLabel(text: string, label: string) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Chip 序列化通常是 “图片2”，也可能带 @；边界匹配避免 图片1 误伤 图片10。
    return new RegExp(`(?:^|[\\s，,。.!！？?:：;；、])@?${escaped}(?=$|[\\s，,。.!！？?:：;；、])`).test(text);
}

function createSession(): CanvasAssistantSession {
    const now = new Date().toISOString();
    return {
        id: nanoid(),
        title: "新对话",
        messages: [],
        agentState: createCanvasAgentState(),
        protocolMessages: [],
        createdAt: now,
        updatedAt: now,
    };
}
