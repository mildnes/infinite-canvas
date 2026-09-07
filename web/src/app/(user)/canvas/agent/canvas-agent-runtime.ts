import {
    CANVAS_AGENT_JSON_FALLBACK_SIGNAL,
    canvasAgentSystemPrompt,
    canvasAgentTokenCalibrationKey,
    isCanvasAgentContextLimitError,
    requestCanvasAgentCheckpoint,
    requestCanvasAgentTurn,
} from "@/services/api/canvas-agent";
import { callAgentMCPTool, fetchAgentSettings } from "@/services/api/agent";
import { fetchSystemAgentSkillFile } from "@/services/api/agent-skills";
import type { AiConfig } from "@/stores/use-config-store";
import type {
    CanvasAgentContent,
    CanvasAgentJsonFallbackMode,
    CanvasAgentProtocolMessage,
    CanvasAgentSkillReference,
    CanvasAgentState,
    CanvasAgentToolMode,
    CanvasAssistantMessageStatus,
    CanvasAssistantReference,
} from "../types";
import type { CanvasAgentContext } from "./canvas-agent-context";
import { buildCanvasAgentSkillPrompt, builtinCanvasAgentSkill } from "./canvas-agent-skills";
import {
    compactCanvasAgentHistory,
    estimateCanvasAgentInputTokens,
    MAX_AGENT_INPUT_TOKENS,
    serializeCanvasAgentMessagesForCheckpoint,
} from "./canvas-agent-memory";
import {
    CANVAS_AGENT_SKILL_FILE_TOOL,
    CANVAS_AGENT_TOOLS,
    canvasAgentActionLabel,
    isCanvasAgentMediaAction,
    normalizeCanvasAgentAction,
    parseCanvasAgentJson,
    userLikelyRequestedCanvasAction,
    type CanvasAgentAction,
    type CanvasAgentToolDefinition,
    type CanvasAgentToolResult,
} from "./canvas-agent-tools";

const MAX_AGENT_STEPS = 12;

export type CanvasAgentRuntimeEvent = {
    status: CanvasAssistantMessageStatus;
    label: string;
};

export type RunCanvasAgentInput = {
    config: AiConfig;
    initialState: CanvasAgentState;
    protocolMessages: CanvasAgentProtocolMessage[];
    userText: string;
    references: CanvasAssistantReference[];
    getContext: (state: CanvasAgentState) => CanvasAgentContext;
    executeAction: (action: CanvasAgentAction) => Promise<CanvasAgentToolResult>;
    onEvent?: (event: CanvasAgentRuntimeEvent) => void;
    onCheckpoint?: (checkpoint: {
        state: CanvasAgentState;
        protocolMessages: CanvasAgentProtocolMessage[];
        contextCheckpoint?: string;
        jsonFallbackMode?: CanvasAgentJsonFallbackMode;
    }) => void;
    signal?: AbortSignal;
    authToken?: string;
    skillReferences?: CanvasAgentSkillReference[];
    activeSkillContents?: Array<{ id: string; source: "system" | "user"; name: string; content: string; hasFiles?: boolean }>;
    contextCheckpoint?: string;
    preferredJsonMode?: CanvasAgentJsonFallbackMode;
};

export type RunCanvasAgentResult = {
    reply: string;
    state: CanvasAgentState;
    protocolMessages: CanvasAgentProtocolMessage[];
    contextCheckpoint?: string;
    jsonFallbackMode?: CanvasAgentJsonFallbackMode;
};

export function createCanvasAgentState(): CanvasAgentState {
    return {
        phase: "intake",
        approvedNodeIds: [],
        referenceNodeIds: [],
        pendingTaskIds: [],
        completedTaskIds: [],
    };
}

export async function runCanvasAgent(input: RunCanvasAgentInput): Promise<RunCanvasAgentResult> {
    let state = input.initialState;
    let toolMode: CanvasAgentToolMode = input.preferredJsonMode || "native";
    let usedJsonFallbackMode = input.preferredJsonMode;
    let hasExecutedActions = false;
    let protocolError: string | undefined;
    let expectedAction = false;
    let protocolMessages: CanvasAgentProtocolMessage[] = [
        ...input.protocolMessages,
        { role: "user" as const, content: buildUserContent(input.userText, input.references, input.config.textModel || input.config.model) },
    ];
    let contextCheckpoint = input.contextCheckpoint;
    const extensions = await loadAgentExtensions(input.authToken);
    const activeSkillPrompt = input.activeSkillContents?.map((skill, index) => `【完整 Skill ${index + 1}：${skill.name}（${skill.source === "system" ? `系统 Skill ID：${skill.id}` : "用户 Skill"}）】\n${skill.content}`).join("\n\n");
    const selectedSkillPrompts = selectedSkillPromptsForInput(input.skillReferences || [], extensions.adminSkillPrompts);
    const explicitSkillSelection = Boolean(input.activeSkillContents?.length || input.skillReferences?.length || /(?:^|\s)\/skill(?:\s|$)/i.test(input.userText));
    const automaticSkillPrompts = explicitSkillSelection ? [] : extensions.skillPrompts;
    const skillFileToolAvailable = Boolean(input.activeSkillContents?.some((skill) => skill.source === "system" && skill.hasFiles));
    const agentTools = [...CANVAS_AGENT_TOOLS, ...(skillFileToolAvailable ? [CANVAS_AGENT_SKILL_FILE_TOOL] : []), ...extensions.tools];
    const buildSkillPrompt = (context: CanvasAgentContext) => buildCanvasAgentSkillPrompt(state.phase, input.userText, context, activeSkillPrompt, contextCheckpoint, skillFileToolAvailable, selectedSkillPrompts, automaticSkillPrompts, explicitSkillSelection);
    const emitCheckpoint = () => input.onCheckpoint?.({ state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint, jsonFallbackMode: usedJsonFallbackMode });

    const compactHistory = async () => {
        const compacted = await compactCanvasAgentHistory({
            protocolMessages,
            contextCheckpoint,
            createCheckpoint: (previousCheckpoint, messages) => requestCanvasAgentCheckpoint({
                config: input.config,
                previousCheckpoint,
                messages: serializeCanvasAgentMessagesForCheckpoint(messages),
                signal: input.signal,
            }),
        });
        if (!compacted.compacted) return false;
        protocolMessages = compacted.protocolMessages;
        contextCheckpoint = compacted.contextCheckpoint;
        emitCheckpoint();
        return true;
    };

    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
        throwIfAborted(input.signal);
        input.onEvent?.({ status: "thinking", label: step ? "正在根据画布结果继续" : "正在理解画布和创作目标" });
        const context = input.getContext(state);
        let systemPrompt = buildSkillPrompt(context);
        const nativeTools = toolMode === "native";
        const tools = nativeTools ? agentTools : [];
        if (estimateCanvasAgentInputTokens({ systemPrompt: canvasAgentSystemPrompt(input.config, systemPrompt, nativeTools ? [] : agentTools, nativeTools), messages: protocolMessages, tools }, canvasAgentTokenCalibrationKey(input.config)) >= MAX_AGENT_INPUT_TOKENS) {
            if (await compactHistory()) {
                systemPrompt = buildSkillPrompt(input.getContext(state));
            }
        }

        const requestTurn = () => requestCanvasAgentTurn({ config: input.config, systemPrompt, messages: protocolMessages, tools: agentTools, toolMode, signal: input.signal });
        let turn: Awaited<ReturnType<typeof requestCanvasAgentTurn>>;
        try {
            turn = await requestTurn();
        } catch (error) {
            if (!isCanvasAgentContextLimitError(error) || !(await compactHistory())) throw error;
            systemPrompt = buildSkillPrompt(input.getContext(state));
            turn = await requestTurn();
        }
        toolMode = turn.toolMode;
        if (toolMode !== "native") usedJsonFallbackMode = toolMode;
        if (!protocolError && !turn.toolError && toolMode === "native" && !turn.toolCalls.length && turn.content.trim() === CANVAS_AGENT_JSON_FALLBACK_SIGNAL) {
            expectedAction = true;
            toolMode = "structured-json";
            usedJsonFallbackMode = toolMode;
            step -= 1;
            continue;
        }

        const parsedJson = await parseCanvasAgentJson(turn.content, { allowRepair: toolMode !== "native", tools: agentTools });
        const assistantToolMessage: CanvasAgentProtocolMessage = {
            role: "assistant",
            content: turn.content || undefined,
            ...(turn.reasoningContent !== undefined ? { reasoningContent: turn.reasoningContent } : {}),
            ...(turn.responseItems?.length ? { responseItems: turn.responseItems } : {}),
            ...(turn.toolCalls.length ? { toolCalls: turn.toolCalls } : {}),
        };
        let nativeActions: CanvasAgentAction[] = [];
        let actionError = turn.toolError || (turn.toolCalls.length ? turn.toolCalls.find((toolCall) => toolCall.argumentsError)?.argumentsError : parsedJson.error);
        if (!actionError && turn.toolCalls.length > MAX_AGENT_STEPS) actionError = "单次最多执行 12 个画布操作，请拆分调用";
        if (!actionError) {
            try {
                nativeActions = turn.toolCalls.map((toolCall) => normalizeCanvasAgentAction(toolCall.name, toolCall.arguments, toolCall.id, agentTools));
            } catch (error) {
                actionError = error instanceof Error ? error.message : "工具参数无效";
            }
        }
        if (!actionError && expectedAction && !nativeActions.length && !parsedJson.actions.length) actionError = "本轮必须返回可执行的画布工具指令";
        if (actionError) {
            if (protocolError) throw new Error("工具指令仍无效，本批操作未执行：" + actionError);
            protocolError = actionError;
            const feedback = JSON.stringify({ ok: false, code: "invalid_tool_arguments", message: actionError + "。本批操作均未执行，未创建节点或提交生成。请按工具定义修正调用；JSON 模式只返回 actions 和 reply，所有工具参数放入 arguments，工具名不得含 Markdown 转义。只修正格式与参数位置，保留完整定稿、已确认总时长和来源引用，不得删减提示词或改用默认时长；不要声称已提交。" });
            protocolMessages = [
                ...protocolMessages,
                ...(assistantToolMessage.content || assistantToolMessage.reasoningContent || assistantToolMessage.responseItems?.length || assistantToolMessage.toolCalls?.length ? [assistantToolMessage] : []),
                ...(turn.toolCalls.length ? turn.toolCalls.map((toolCall) => ({ role: "tool" as const, toolCallId: toolCall.id, name: toolCall.name, content: feedback })) : [{ role: "user" as const, content: "工具执行结果（只可依据这些真实结果继续）：\n" + feedback }]),
            ];
            emitCheckpoint();
            step -= 1;
            continue;
        }

        const requestedActions = nativeActions.length ? nativeActions : parsedJson.actions;
        const mcpCalls = requestedActions.filter((action) => action.name.startsWith("mcp__"));
        const arrangeRequested = /整理|排列|排序|对齐|布局|排版|重新摆放/.test(input.userText) && !/(不要|别|无需|不用).{0,8}(整理|排列|排序|对齐|布局|排版|重新摆放)/.test(input.userText);
        const actions = requestedActions.filter((action) => !action.name.startsWith("mcp__") && (action.name !== "arrange_nodes" || arrangeRequested));
        const rejectedToolMessages: CanvasAgentProtocolMessage[] = nativeActions.filter((action) => action.name === "arrange_nodes" && !arrangeRequested).map((action) => ({ role: "tool", toolCallId: action.id, name: action.name, content: JSON.stringify({ ok: false, code: "action_not_requested", message: "用户没有要求整理画布，未执行节点排列" }) }));

        if (!actions.length && !mcpCalls.length && protocolError) throw new Error("修正后仍未返回可执行的工具指令，本批操作未执行：" + protocolError);
        if (!actions.length && !mcpCalls.length && rejectedToolMessages.length) {
            protocolMessages = [...protocolMessages, assistantToolMessage, ...rejectedToolMessages];
            emitCheckpoint();
            continue;
        }
        if (!actions.length && !mcpCalls.length) {
            const reply = (parsedJson.parsed ? parsedJson.reply : turn.content).trim();
            if (!hasExecutedActions && !reply && userLikelyRequestedCanvasAction(input.userText)) {
                const unsupported = "当前接口没有返回可执行的画布工具指令。请点击输入框右下角的大脑图标，尝试切换 Chat / Responses，或更换支持 Tool Calling 或稳定 JSON 输出的文本模型。";
                protocolMessages = [...protocolMessages, { role: "assistant" as const, content: unsupported }];
                return { reply: unsupported, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint, jsonFallbackMode: usedJsonFallbackMode };
            }
            const finalReply = reply || "我已经读取当前画布。请告诉我下一步要继续完善哪一部分。";
            protocolMessages = [...protocolMessages, { role: "assistant" as const, content: finalReply, ...(turn.responseItems?.length ? { responseItems: turn.responseItems } : {}) }];
            return { reply: finalReply, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint, jsonFallbackMode: usedJsonFallbackMode };
        }

        expectedAction = false;
        protocolError = undefined;
        input.onEvent?.({ status: "running", label: mcpCalls.length ? "正在调用 MCP 工具" : actions.length === 1 ? canvasAgentActionLabel(actions[0]) : "正在执行 " + actions.length + " 个画布操作" });
        const results = await executeActions(actions, state, (action) => executeRuntimeAction(action, input), input.signal, input.onEvent);
        const mcpResults = await Promise.all(mcpCalls.map(async (call) => {
            const target = extensions.lookup.get(call.name);
            if (!target || !input.authToken) return { id: call.id, name: call.name, result: { ok: false, code: "mcp_unavailable", message: "MCP 调用需要登录且工具必须已配置" } };
            try {
                const result = await callAgentMCPTool(input.authToken, { serverId: target.serverId, toolName: target.toolName, arguments: call.arguments });
                return { id: call.id, name: call.name, result: { ok: true, ...result } };
            } catch (error) {
                return { id: call.id, name: call.name, result: { ok: false, code: "mcp_call_failed", message: error instanceof Error ? error.message : "MCP 工具调用失败" } };
            }
        }));
        hasExecutedActions = true;
        state = results.state;

        if (nativeActions.length && toolMode === "native") {
            protocolMessages = [
                ...protocolMessages,
                assistantToolMessage,
                ...results.items.map(({ action, result }) => ({ role: "tool" as const, toolCallId: action.id, name: action.name, content: serializeToolResult(result) })),
                ...mcpResults.map((item) => ({ role: "tool" as const, toolCallId: item.id, name: item.name, content: serializeToolResult(item.result) })),
                ...rejectedToolMessages,
            ];
        } else {
            protocolMessages = [
                ...protocolMessages,
                assistantToolMessage,
                { role: "user" as const, content: "工具执行结果（只可依据这些真实结果继续）：\n" + JSON.stringify([...results.items.map(({ action, result }) => ({ tool: action.name, id: action.id, result })), ...mcpResults.map((item) => ({ tool: item.name, id: item.id, result: item.result }))]) },
            ];
        }
        emitCheckpoint();
    }

    const reply = "本轮已达到安全操作步数上限，当前已完成的节点和任务都已保存。你可以让我继续下一步。";
    protocolMessages = [...protocolMessages, { role: "assistant" as const, content: reply }];
    return { reply, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint, jsonFallbackMode: usedJsonFallbackMode };
}

async function loadAgentExtensions(authToken?: string) {
    const result: {
        skillPrompts: string[];
        adminSkillPrompts: Map<string, string>;
        tools: CanvasAgentToolDefinition[];
        lookup: Map<string, { serverId: string; toolName: string }>;
    } = { skillPrompts: [], adminSkillPrompts: new Map(), tools: [], lookup: new Map() };
    try {
        const settings = await fetchAgentSettings(authToken);
        result.skillPrompts = settings.skills.filter((skill) => skill.enabled && skill.prompt.trim()).map((skill) => `【后台 Skill：${skill.name}】\n${skill.prompt}`);
        for (const skill of settings.skills) {
            if (skill.enabled && skill.prompt.trim()) result.adminSkillPrompts.set(skill.id, `【后台 Skill：${skill.name}】\n${skill.prompt}`);
        }
        for (const server of settings.mcpServers) {
            for (const tool of server.tools || []) {
                const toolName = tool.name.trim();
                if (!toolName) continue;
                const name = `mcp__${server.id}__${toolName}`;
                result.lookup.set(name, { serverId: server.id, toolName });
                const sourceSchema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
                const parameters = {
                    ...sourceSchema,
                    type: "object" as const,
                    properties: isRecord(sourceSchema.properties) ? sourceSchema.properties : {},
                    ...(Array.isArray(sourceSchema.required) ? { required: sourceSchema.required.filter((item): item is string => typeof item === "string") } : {}),
                } as CanvasAgentToolDefinition["function"]["parameters"];
                result.tools.push({ type: "function", function: { name, description: `${server.name}：${tool.description || toolName}`, parameters } });
            }
        }
    } catch {
        // 后台扩展不可用时，继续使用内置 Agent 能力。
    }
    return result;
}

function selectedSkillPromptsForInput(references: CanvasAgentSkillReference[], adminSkillPrompts: Map<string, string>) {
    return references.flatMap((reference) => {
        if (reference.source === "admin") {
            const prompt = adminSkillPrompts.get(reference.id);
            return prompt ? [prompt] : [];
        }
        const skill = builtinCanvasAgentSkill(reference.id);
        return skill ? [skill.prompt] : [];
    });
}

function serializeToolResult(result: unknown) {
    const serialized = JSON.stringify(result) || String(result);
    if (serialized.length <= 20000) return serialized;
    return JSON.stringify({ ok: false, code: "tool_result_truncated", message: "工具结果过大，已截取前 18000 个字符", preview: serialized.slice(0, 18000) });
}

async function executeRuntimeAction(action: CanvasAgentAction, input: RunCanvasAgentInput): Promise<CanvasAgentToolResult> {
    if (action.name === "read_skill_file") {
        const skillId = typeof action.arguments.skillId === "string" ? action.arguments.skillId : "";
        const path = typeof action.arguments.path === "string" ? action.arguments.path : "";
        const activeSkill = input.activeSkillContents?.find((skill) => skill.id === skillId && skill.source === "system" && skill.hasFiles);
        if (!activeSkill) return { ok: false, code: "skill_not_active", message: "只能读取当前激活且带附属文件的系统 Skill" };
        try {
            const file = await fetchSystemAgentSkillFile(skillId, path);
            return { ok: true, skillId, path: file.path, content: file.content };
        } catch (error) {
            return { ok: false, code: "skill_file_not_found", message: error instanceof Error ? error.message : "Skill 文件读取失败" };
        }
    }
    return input.executeAction(action);
}

async function executeActions(actions: CanvasAgentAction[], initialState: CanvasAgentState, executeAction: (action: CanvasAgentAction) => Promise<CanvasAgentToolResult>, signal?: AbortSignal, onEvent?: (event: CanvasAgentRuntimeEvent) => void) {
    let state = initialState;
    const executeOne = async (action: CanvasAgentAction) => {
        throwIfAborted(signal);
        onEvent?.({ status: "running", label: canvasAgentActionLabel(action) });
        try {
            const result = await executeAction(action);
            if (action.name === "set_agent_state" && result.ok) state = applyAgentState(state, action.arguments);
            else state = applyTaskResult(state, result);
            return { action, result };
        } catch (error) {
            return { action, result: { ok: false, code: "tool_execution_failed", message: error instanceof Error ? error.message : "工具执行失败" } satisfies CanvasAgentToolResult };
        }
    };
    const items = actions.every(isCanvasAgentMediaAction) ? await Promise.all(actions.map(executeOne)) : await actions.reduce<Promise<Array<{ action: CanvasAgentAction; result: CanvasAgentToolResult }>>>(async (pending, action) => [...(await pending), await executeOne(action)], Promise.resolve([]));
    return { items, state };
}

function buildUserContent(text: string, references: CanvasAssistantReference[], modelName: string): CanvasAgentContent {
    const referenceText = references.length ? "\n\n本次输入中的节点占位与真实节点一一对应，请按占位分别理解和操作：" + references.map((item) => `${item.label || item.title} → 节点 ${item.id}（${item.title}）`).join("；") : "";
    const imageReferences = references.filter((item) => item.dataUrl && (/^data:image\//.test(item.dataUrl) || /^https?:\/\//.test(item.dataUrl)));
    const imageOrderText = imageReferences.length ? "\n随消息附带的图片顺序：" + imageReferences.map((item, index) => `第 ${index + 1} 张 = ${item.label || item.title}`).join("；") : "";
    const images = supportsCanvasAgentImageInput(modelName) ? imageReferences.map((item) => ({ type: "image_url" as const, image_url: { url: item.dataUrl as string } })) : [];
    if (!images.length) return text + referenceText;
    return [{ type: "text", text: text + referenceText + imageOrderText }, ...images];
}

function supportsCanvasAgentImageInput(modelName: string) {
    const model = modelName.trim().toLowerCase();
    return model === "mimo-v2.5" || /gpt-(?:4o|4\.1|5)|(?:^|[\\/_-])o[134](?:[\\/_-]|$)|gemini|claude|qwen.*(?:vl|vision)|glm-4v|pixtral|llava|internvl|deepseek.*vl|vision/.test(model);
}

function persistCanvasAgentProtocolMessages(messages: CanvasAgentProtocolMessage[]) {
    return messages.map((message): CanvasAgentProtocolMessage => {
        if ((message.role === "user" || message.role === "system") && Array.isArray(message.content)) {
            const text = message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
            return { role: message.role, content: text || "本轮包含图片引用；媒体内容未写入会话记录。" };
        }
        return message;
    });
}

function applyAgentState(state: CanvasAgentState, patch: Record<string, unknown>): CanvasAgentState {
    return {
        ...state,
        phase: typeof patch.phase === "string" ? (patch.phase as CanvasAgentState["phase"]) : state.phase,
        brief: typeof patch.brief === "string" ? patch.brief : state.brief,
        targetDurationSeconds: typeof patch.targetDurationSeconds === "number" ? patch.targetDurationSeconds : state.targetDurationSeconds,
        approvedPlan: typeof patch.approvedPlan === "string" ? patch.approvedPlan : state.approvedPlan,
        approvedNodeIds: Array.isArray(patch.approvedNodeIds) ? (patch.approvedNodeIds as string[]) : state.approvedNodeIds,
        referenceNodeIds: Array.isArray(patch.referenceNodeIds) ? (patch.referenceNodeIds as string[]) : state.referenceNodeIds,
    };
}

function applyTaskResult(state: CanvasAgentState, result: CanvasAgentToolResult): CanvasAgentState {
    const taskId = typeof result.taskId === "string" ? result.taskId : "";
    if (!taskId) return state;
    const completed = result.status === "success" || result.status === "completed";
    const terminal = completed || result.status === "error" || result.status === "failed";
    return {
        ...state,
        pendingTaskIds: terminal ? state.pendingTaskIds.filter((id) => id !== taskId) : [...new Set([...state.pendingTaskIds, taskId])],
        completedTaskIds: completed ? [...new Set([...state.completedTaskIds, taskId])] : state.completedTaskIds,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal) {
    if (!signal?.aborted) return;
    const error = new Error("Agent 已停止");
    error.name = "AbortError";
    throw error;
}
