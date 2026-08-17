import { requestCanvasAgentTurn } from "@/services/api/canvas-agent";
import { callAgentMCPTool, fetchAgentSettings } from "@/services/api/agent";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasAgentContent, CanvasAgentProtocolMessage, CanvasAgentState, CanvasAssistantMessageStatus, CanvasAssistantReference, CanvasAgentSkillReference } from "../types";
import type { CanvasAgentContext } from "./canvas-agent-context";
import { buildCanvasAgentSkillPromptWithExtra, builtinCanvasAgentSkill } from "./canvas-agent-skills";
import {
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
const MAX_PROTOCOL_MESSAGES = 120;

function trimProtocolMessages(messages: CanvasAgentProtocolMessage[]) {
    const trimmed = messages.slice(-MAX_PROTOCOL_MESSAGES);
    while (trimmed[0]?.role === "tool") trimmed.shift();
    return trimmed;
}

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
    onCheckpoint?: (checkpoint: { state: CanvasAgentState; protocolMessages: CanvasAgentProtocolMessage[] }) => void;
    signal?: AbortSignal;
    authToken?: string;
    skillReferences?: CanvasAgentSkillReference[];
};

export type RunCanvasAgentResult = {
    reply: string;
    state: CanvasAgentState;
    protocolMessages: CanvasAgentProtocolMessage[];
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
    let protocolMessages: CanvasAgentProtocolMessage[] = trimProtocolMessages([...input.protocolMessages, { role: "user" as const, content: buildUserContent(input.userText, input.references, input.config.textModel || input.config.model) }]);
    const extensions = await loadAgentExtensions(input.authToken);

    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
        throwIfAborted(input.signal);
        input.onEvent?.({ status: "thinking", label: step ? "正在根据画布结果继续" : "正在理解画布和创作目标" });
        const context = input.getContext(state);
        const turn = await requestCanvasAgentTurn({
            config: input.config,
            systemPrompt: buildCanvasAgentSkillPromptWithExtra(state.phase, input.userText, context, [...extensions.skillPrompts, ...selectedSkillPrompts(input.skillReferences || [], extensions.adminSkillPrompts)]),
            messages: protocolMessages,
            tools: [...CANVAS_AGENT_TOOLS, ...extensions.tools],
            allowTools,
            signal: input.signal,
        });
        if (turn.usedJsonFallback) allowTools = false;

        const parsedJson = parseCanvasAgentJson(turn.content);
        const mcpCalls = turn.toolCalls.filter((toolCall) => toolCall.name.startsWith("mcp__"));
        const nativeActions = turn.toolCalls.filter((toolCall) => !toolCall.name.startsWith("mcp__")).map((toolCall) => normalizeCanvasAgentAction(toolCall.name, toolCall.arguments, toolCall.id));
        const arrangeRequested = /整理|排列|排序|对齐|布局|排版|重新摆放/.test(input.userText) && !/(不要|别|无需|不用).{0,8}(整理|排列|排序|对齐|布局|排版|重新摆放)/.test(input.userText);
        const actions = mcpCalls.length && !nativeActions.length ? [] : (nativeActions.length ? nativeActions : parsedJson.actions).filter((action) => action.name !== "arrange_nodes" || arrangeRequested);

        if (!actions.length && !mcpCalls.length) {
            const reply = (parsedJson.parsed ? parsedJson.reply : turn.content).trim();
            if (!hasExecutedActions && userLikelyRequestedCanvasAction(input.userText) && !looksLikeClarifyingQuestion(reply)) {
                const unsupported = "当前文本模型没有返回可执行的画布工具指令。可以继续讨论文本内容，但无法可靠地自动创建节点或执行生成；请在全局配置中更换支持 Tool Calling 或稳定 JSON 输出的文本模型。";
                protocolMessages = trimProtocolMessages([...protocolMessages, { role: "assistant" as const, content: unsupported }]);
                return { reply: unsupported, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages) };
            }
            const finalReply = reply || "我已经读取当前画布。请告诉我下一步要继续完善哪一部分。";
            protocolMessages = trimProtocolMessages([...protocolMessages, { role: "assistant" as const, content: finalReply }]);
            return { reply: finalReply, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages) };
        }

        input.onEvent?.({ status: "running", label: mcpCalls.length ? "正在调用 MCP 工具" : actions.length === 1 ? canvasAgentActionLabel(actions[0]) : "正在执行 " + actions.length + " 个画布操作" });
        const assistantToolMessage: CanvasAgentProtocolMessage =
            nativeActions.length || mcpCalls.length
                ? {
                      role: "assistant",
                      content: turn.content || undefined,
                      ...(turn.reasoningContent !== undefined ? { reasoningContent: turn.reasoningContent } : {}),
                      toolCalls: [...actions.map((action) => ({ id: action.id, name: action.name, arguments: action.arguments })), ...mcpCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }))],
                  }
                : { role: "assistant", content: turn.content };

        const results = await executeActions(actions, state, input.executeAction, input.signal, input.onEvent);
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
            protocolMessages = trimProtocolMessages([
                ...protocolMessages,
                assistantToolMessage,
                ...results.items.map(({ action, result }) => ({
                    role: "tool" as const,
                    toolCallId: action.id,
                    name: action.name,
                    content: serializeToolResult(result),
                })),
                ...mcpResults.map((item) => ({ role: "tool" as const, toolCallId: item.id, name: item.name, content: serializeToolResult(item.result) })),
            ]);
        } else {
            protocolMessages = trimProtocolMessages([
                ...protocolMessages,
                assistantToolMessage,
                {
                    role: "user" as const,
                    content: "工具执行结果（只可依据这些真实结果继续）：\n" + JSON.stringify(results.items.map(({ action, result }) => ({ tool: action.name, id: action.id, result }))),
                },
            ]);
        }
        input.onCheckpoint?.({ state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages) });
    }

    const reply = "本轮已达到安全操作步数上限，当前已完成的节点和任务都已保存。你可以让我继续下一步。";
    protocolMessages = trimProtocolMessages([...protocolMessages, { role: "assistant" as const, content: reply }]);
    return { reply, state, protocolMessages: persistCanvasAgentProtocolMessages(protocolMessages) };
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

function looksLikeClarifyingQuestion(text: string) {
    return /[?？]|请(?:告诉|选择|确认|提供)|需要.{0,12}(?:吗|呢)|希望.{0,12}(?:吗|呢)/.test(text);
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
