import { canvasAgentSystemPrompt, canvasAgentTokenCalibrationKey, isCanvasAgentContextLimitError, requestCanvasAgentCheckpoint, requestCanvasAgentTurn } from "@/services/api/canvas-agent";
import { callAgentMCPTool, fetchAgentSettings } from "@/services/api/agent";
import { fetchSystemAgentSkillFile } from "@/services/api/agent-skills";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasAgentContent, CanvasAgentProtocolMessage, CanvasAgentState, CanvasAssistantMessageStatus, CanvasAssistantReference, CanvasAgentSkillReference } from "../types";
import type { CanvasAgentContext } from "./canvas-agent-context";
import type { CanvasAgentAssistantProtocolMessage } from "./canvas-agent-compat";
import { buildCanvasAgentSkillPromptWithExtra, builtinCanvasAgentSkill } from "./canvas-agent-skills";
import { compactCanvasAgentHistory, estimateCanvasAgentInputTokens, MAX_AGENT_INPUT_TOKENS, serializeCanvasAgentMessagesForCheckpoint } from "./canvas-agent-memory";
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
    onCheckpoint?: (checkpoint: { state: CanvasAgentState; protocolMessages: CanvasAgentProtocolMessage[]; contextCheckpoint?: string }) => void;
    signal?: AbortSignal;
    authToken?: string;
    skillReferences?: CanvasAgentSkillReference[];
    activeSkillContents?: Array<{ id: string; source: "system" | "user"; name: string; content: string; hasFiles?: boolean }>;
    contextCheckpoint?: string;
};

export type RunCanvasAgentResult = {
    reply: string;
    state: CanvasAgentState;
    protocolMessages: CanvasAgentProtocolMessage[];
    contextCheckpoint?: string;
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
    let allowTools = true;
    let hasExecutedActions = false;
    let protocolMessages: CanvasAgentProtocolMessage[] = [...input.protocolMessages, { role: "user" as const, content: buildUserContent(input.userText, input.references, input.config.textModel || input.config.model) }];
    let contextCheckpoint = input.contextCheckpoint;
    const extensions = await loadAgentExtensions(input.authToken);
    const activeSkillPrompt = input.activeSkillContents?.map((skill, index) => `【完整 Skill ${index + 1}：${skill.name}（${skill.source === "system" ? `系统 Skill ID：${skill.id}` : "用户 Skill"}）】\n${skill.content}`).join("\n\n");
    const skillFileToolAvailable = Boolean(input.activeSkillContents?.some((skill) => skill.source === "system" && skill.hasFiles));
    const agentTools = [...CANVAS_AGENT_TOOLS, ...(skillFileToolAvailable ? [CANVAS_AGENT_SKILL_FILE_TOOL] : []), ...extensions.tools];
    const extraSkills = [...extensions.skillPrompts, ...selectedSkillPrompts(input.skillReferences || [], extensions.adminSkillPrompts), ...(activeSkillPrompt ? [activeSkillPrompt] : [])];
    const emitCheckpoint = () => input.onCheckpoint?.({ state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint });
    const compactHistory = async () => {
        const compacted = await compactCanvasAgentHistory({
            protocolMessages,
            contextCheckpoint,
            createCheckpoint: (previousCheckpoint, messages) =>
                requestCanvasAgentCheckpoint({
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
        let systemPrompt = buildCanvasAgentSkillPromptWithExtra(state.phase, input.userText, context, extraSkills, contextCheckpoint, skillFileToolAvailable);
        const enabledTools = allowTools ? agentTools : [];
        if (estimateCanvasAgentInputTokens({ systemPrompt: canvasAgentSystemPrompt(input.config, systemPrompt), messages: protocolMessages, tools: enabledTools }, canvasAgentTokenCalibrationKey(input.config)) >= MAX_AGENT_INPUT_TOKENS) {
            if (await compactHistory()) systemPrompt = buildCanvasAgentSkillPromptWithExtra(state.phase, input.userText, context, extraSkills, contextCheckpoint, skillFileToolAvailable);
        }
        const requestTurn = () => requestCanvasAgentTurn({ config: input.config, systemPrompt, messages: protocolMessages, tools: agentTools, allowTools, signal: input.signal });
        let turn: Awaited<ReturnType<typeof requestCanvasAgentTurn>>;
        try {
            turn = await requestTurn();
        } catch (error) {
            if (!isCanvasAgentContextLimitError(error) || !(await compactHistory())) throw error;
            systemPrompt = buildCanvasAgentSkillPromptWithExtra(state.phase, input.userText, context, extraSkills, contextCheckpoint, skillFileToolAvailable);
            turn = await requestTurn();
        }
        if (turn.usedJsonFallback) allowTools = false;

        const parsedJson = parseCanvasAgentJson(turn.content);
        const mcpCalls = turn.toolCalls.filter((toolCall) => toolCall.name.startsWith("mcp__"));
        const nativeActions = turn.toolCalls.filter((toolCall) => !toolCall.name.startsWith("mcp__")).map((toolCall) => normalizeCanvasAgentAction(toolCall.name, toolCall.arguments, toolCall.id));
        const arrangeRequested = /整理|排列|排序|对齐|布局|排版|重新摆放/.test(input.userText) && !/(不要|别|无需|不用).{0,8}(整理|排列|排序|对齐|布局|排版|重新摆放)/.test(input.userText);
        const actions = mcpCalls.length && !nativeActions.length ? [] : (nativeActions.length ? nativeActions : parsedJson.actions).filter((action) => action.name !== "arrange_nodes" || arrangeRequested);

        if (!actions.length && !mcpCalls.length) {
            const reply = (parsedJson.parsed ? parsedJson.reply : turn.content).trim();
            if (!hasExecutedActions && !reply && userLikelyRequestedCanvasAction(input.userText)) {
                const unsupported = "当前接口没有返回可执行的画布工具指令。请尝试切换 Chat / Responses，或更换支持 Tool Calling 或稳定 JSON 输出的文本模型。";
                protocolMessages = [...protocolMessages, { role: "assistant" as const, content: unsupported }];
                return { reply: unsupported, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint };
            }
            const finalReply = reply || "我已经读取当前画布。请告诉我下一步要继续完善哪一部分。";
            protocolMessages = [...protocolMessages, { role: "assistant" as const, content: finalReply }];
            return { reply: finalReply, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint };
        }

        input.onEvent?.({ status: "running", label: mcpCalls.length ? "正在调用 MCP 工具" : actions.length === 1 ? canvasAgentActionLabel(actions[0]) : "正在执行 " + actions.length + " 个画布操作" });
        const assistantToolMessage: CanvasAgentProtocolMessage =
            nativeActions.length || mcpCalls.length
                ? ({
                      role: "assistant",
                      content: turn.content || undefined,
                      ...(turn.reasoningContent !== undefined ? { reasoningContent: turn.reasoningContent } : {}),
                      ...(turn.responseItems ? { responseItems: turn.responseItems } : {}),
                      toolCalls: [...actions.map((action) => ({ id: action.id, name: action.name, arguments: action.arguments })), ...mcpCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }))],
                  } as CanvasAgentAssistantProtocolMessage)
                : { role: "assistant", content: turn.content };

        const results = await executeActions(actions, state, (action) => executeRuntimeAction(action, input, state), input.signal, input.onEvent);
        const mcpResults = await Promise.all(
            mcpCalls.map(async (call) => {
                const target = extensions.lookup.get(call.name);
                if (!target || !input.authToken) return { id: call.id, name: call.name, result: { ok: false, message: "MCP 调用需要登录且工具必须已配置" } };
                try {
                    const result = await callAgentMCPTool(input.authToken, { serverId: target.serverId, toolName: target.toolName, arguments: call.arguments });
                    return { id: call.id, name: call.name, result: { ok: true, ...result } };
                } catch (error) {
                    return { id: call.id, name: call.name, result: { ok: false, message: error instanceof Error ? error.message : "MCP 工具调用失败" } };
                }
            }),
        );
        hasExecutedActions = true;
        state = results.state;

        if ((nativeActions.length || mcpCalls.length) && allowTools) {
            protocolMessages = [
                ...protocolMessages,
                assistantToolMessage,
                ...results.items.map(({ action, result }) => ({
                    role: "tool" as const,
                    toolCallId: action.id,
                    name: action.name,
                    content: serializeToolResult(result),
                })),
                ...mcpResults.map((item) => ({ role: "tool" as const, toolCallId: item.id, name: item.name, content: serializeToolResult(item.result) })),
            ];
        } else {
            protocolMessages = [
                ...protocolMessages,
                assistantToolMessage,
                {
                    role: "user" as const,
                    content:
                        "工具执行结果（只可依据这些真实结果继续）：\n" +
                        JSON.stringify([...results.items.map(({ action, result }) => ({ tool: action.name, id: action.id, result })), ...mcpResults.map((item) => ({ tool: item.name, id: item.id, result: item.result }))]),
                },
            ];
        }
        emitCheckpoint();
    }

    const reply = "本轮已达到安全操作步数上限，当前已完成的节点和任务都已保存。你可以让我继续下一步。";
    protocolMessages = [...protocolMessages, { role: "assistant" as const, content: reply }];
    return { reply, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages), contextCheckpoint };
}

async function loadAgentExtensions(authToken?: string) {
    const result = { skillPrompts: [] as string[], adminSkillPrompts: new Map<string, string>(), tools: [] as typeof CANVAS_AGENT_TOOLS, lookup: new Map<string, { serverId: string; toolName: string }>() };
    try {
        const settings = await fetchAgentSettings(authToken);
        result.skillPrompts = settings.skills.filter((skill) => skill.enabled && skill.prompt.trim()).map((skill) => `【后台 Skill：${skill.name}】\n${skill.prompt}`);
        for (const skill of settings.skills) {
            if (skill.enabled && skill.prompt.trim()) result.adminSkillPrompts.set(skill.id, `【后台 Skill：${skill.name}】\n${skill.prompt}`);
        }
        for (const server of settings.mcpServers)
            for (const tool of server.tools || []) {
                const name = `mcp__${server.id}__${tool.name}`;
                result.lookup.set(name, { serverId: server.id, toolName: tool.name });
                const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {};
                const parameters = {
                    ...schema,
                    type: "object" as const,
                    properties: isRecord(schema.properties) ? schema.properties : {},
                    ...(Array.isArray(schema.required) ? { required: schema.required.filter((item): item is string => typeof item === "string") } : {}),
                } as CanvasAgentToolDefinition["function"]["parameters"];
                result.tools.push({ type: "function", function: { name, description: `${server.name}：${tool.description || tool.name}`, parameters } });
            }
    } catch {
        // 后台扩展不可用时，继续使用内置 Agent 能力。
    }
    return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function selectedSkillPrompts(references: CanvasAgentSkillReference[], adminSkillPrompts: Map<string, string>) {
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
    const serialized = JSON.stringify(result);
    if (serialized.length <= 20000) return serialized;
    return JSON.stringify({ ok: false, code: "tool_result_truncated", message: "工具结果过大，已截取前 18000 个字符", preview: serialized.slice(0, 18000) });
}

async function executeRuntimeAction(action: CanvasAgentAction, input: RunCanvasAgentInput, state: CanvasAgentState): Promise<CanvasAgentToolResult> {
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
            return {
                action,
                result: {
                    ok: false,
                    code: "tool_execution_failed",
                    message: error instanceof Error ? error.message : "工具执行失败",
                } satisfies CanvasAgentToolResult,
            };
        }
    };

    const items = actions.every(isCanvasAgentMediaAction)
        ? await Promise.all(actions.map(executeOne))
        : await actions.reduce<Promise<Array<{ action: CanvasAgentAction; result: CanvasAgentToolResult }>>>(async (pending, action) => [...(await pending), await executeOne(action)], Promise.resolve([]));
    return { items, state };
}

function buildUserContent(text: string, references: CanvasAssistantReference[], modelName: string): CanvasAgentContent {
    const referenceText = references.length ? "\n\n本次明确引用的真实节点：" + references.map((item) => item.id + "（" + item.title + "）").join("、") : "";
    const images = supportsCanvasAgentImageInput(modelName)
        ? references.flatMap((item) => {
              const url = item.dataUrl;
              return url && (/^data:image\//.test(url) || /^https?:\/\//.test(url)) ? [{ type: "image_url" as const, image_url: { url } }] : [];
          })
        : [];
    if (!images.length) return text + referenceText;
    return [{ type: "text", text: text + referenceText }, ...images];
}

function supportsCanvasAgentImageInput(modelName: string) {
    const model = modelName.trim().toLowerCase();
    return model === "mimo-v2.5" || /gpt-(?:4o|4\.1|5)|(?:^|[\\/_-])o[134](?:[\\/_-]|$)|gemini|claude|qwen.*(?:vl|vision)|glm-4v|pixtral|llava|internvl|deepseek.*vl|vision/.test(model);
}

function persistCanvasAgentProtocolMessages(messages: CanvasAgentProtocolMessage[]) {
    return messages.map((message): CanvasAgentProtocolMessage => {
        if ((message.role === "user" || message.role === "system") && Array.isArray(message.content)) {
            const text = message.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n")
                .trim();
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

function throwIfAborted(signal?: AbortSignal) {
    if (!signal?.aborted) return;
    const error = new Error("Agent 已停止");
    error.name = "AbortError";
    throw error;
}
