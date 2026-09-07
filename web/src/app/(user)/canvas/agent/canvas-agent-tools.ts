import { nanoid } from "nanoid";

import type { CanvasAgentPhase } from "../types";

export const CANVAS_AGENT_ACTION_NAMES = [
    "get_canvas_summary",
    "get_selected_nodes",
    "query_canvas_nodes",
    "get_node",
    "get_upstream_nodes",
    "get_downstream_nodes",
    "get_connected_nodes",
    "get_generation_config",
    "get_generation_task",
    "set_agent_state",
    "create_primary_script_node",
    "create_text_node",
    "update_text_node",
    "update_node",
    "delete_node",
    "create_connection",
    "delete_connection",
    "create_group",
    "arrange_nodes",
    "generate_image",
    "edit_image",
    "generate_video",
    "generate_audio",
    "create_media_node",
    "get_media_task_status",
] as const;

export type CanvasAgentActionName = (typeof CANVAS_AGENT_ACTION_NAMES)[number];

export type CanvasAgentAction = {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
};

export type CanvasAgentToolResult = {
    ok: boolean;
    code?: string;
    message?: string;
    [key: string]: unknown;
};

export type CanvasAgentToolDefinition = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown> & {
            type: "object";
            properties: Record<string, unknown>;
            required?: string[];
            additionalProperties?: boolean | Record<string, unknown>;
        };
    };
};

export type ParsedCanvasAgentJson = {
    parsed: boolean;
    actions: CanvasAgentAction[];
    reply: string;
    error?: string;
};

const STRING = { type: "string" };
const STRING_ARRAY = { type: "array", items: { type: "string" }, maxItems: 50 };
const NODE_TYPES = ["image", "panorama", "text", "config", "video", "audio", "director", "group"];
const PHASES: CanvasAgentPhase[] = ["intake", "concept", "script", "breakdown", "references", "storyboard", "video", "audio", "review", "complete"];

function defineTool(name: string, description: string, properties: Record<string, unknown> = {}, required?: string[]): CanvasAgentToolDefinition {
    return {
        type: "function",
        function: {
            name,
            description,
            parameters: {
                type: "object",
                properties,
                ...(required ? { required } : {}),
                additionalProperties: false,
            },
        },
    };
}

export const CANVAS_AGENT_TOOLS: CanvasAgentToolDefinition[] = [
    defineTool("get_canvas_summary", "读取当前画布摘要、节点、连线、模型配置和任务状态。"),
    defineTool("get_selected_nodes", "读取用户当前选中的真实画布节点。"),
    defineTool("query_canvas_nodes", "当默认上下文中没有目标节点 ID 时，按 ID、关键词或类型只读查询画布节点；找到 ID 后再用 get_node 读取详情。", {
        nodeId: STRING,
        keyword: STRING,
        type: { type: "string", enum: NODE_TYPES },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 50 },
    }),
    defineTool("get_node", "按真实节点 ID 读取节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_upstream_nodes", "读取指定节点的所有直接上游节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_downstream_nodes", "读取指定节点的所有直接下游节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_connected_nodes", "读取指定节点直接连接的上下游节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_generation_config", "读取全局模型和渠道，以及当前画布 Agent 独立保存的图片质量、图片尺寸、视频清晰度、视频尺寸、时长和声音配置。"),
    defineTool("get_generation_task", "读取指定媒体节点的真实生成任务状态。", { nodeId: STRING }, ["nodeId"]),
    defineTool(
        "set_agent_state",
        "保存当前创作阶段、已确认方案和正式参考，供刷新后继续。",
        {
            phase: { type: "string", enum: PHASES },
            brief: STRING,
            targetDurationSeconds: { type: "number", minimum: 1 },
            approvedPlan: STRING,
            approvedNodeIds: STRING_ARRAY,
            referenceNodeIds: STRING_ARRAY,
        },
        ["phase"],
    ),
    defineTool("create_primary_script_node", "仅用于新创作流程首次创建正式主剧本或总制作稿，固定使用主剧本节点尺寸。", { title: STRING, content: STRING, sourceNodeIds: STRING_ARRAY, projectTitle: STRING }, ["title", "content", "projectTitle"]),
    defineTool("create_text_node", "创建镜头、角色、产品、场景、声音说明和其他普通文本节点；不得用于首次正式主剧本。", { title: STRING, content: STRING, sourceNodeIds: STRING_ARRAY }, ["title", "content"]),
    defineTool("update_text_node", "更新现有文本节点的标题或正文。", { nodeId: STRING, title: STRING, content: STRING }, ["nodeId"]),
    defineTool("update_node", "只更新现有节点标题；不允许任意字段覆盖。", { nodeId: STRING, title: STRING }, ["nodeId", "title"]),
    defineTool("delete_node", "使用画布现有删除链路删除节点及关联连线。", { nodeId: STRING }, ["nodeId"]),
    defineTool("create_connection", "在两个真实节点之间创建来源连线。", { fromNodeId: STRING, toNodeId: STRING }, ["fromNodeId", "toNodeId"]),
    defineTool("delete_connection", "删除指定真实连线。", { connectionId: STRING }, ["connectionId"]),
    defineTool("create_group", "把两个或更多节点放进本项目 group 节点。", { title: STRING, nodeIds: STRING_ARRAY }, ["nodeIds"]),
    defineTool("arrange_nodes", "整理指定节点；不传 nodeIds 时整理当前画布顶层节点。", { nodeIds: STRING_ARRAY }),
    defineTool(
        "generate_image",
        "调用现有图片任务链路。sourceNodeIds 只放真实直接来源，独立生成必须传空数组；其中图片按数组顺序编号为图片1、图片2。",
        {
            prompt: STRING,
            title: STRING,
            sourceNodeIds: STRING_ARRAY,
            size: STRING,
            count: { type: "integer", minimum: 1, maximum: 15 },
        },
        ["prompt", "sourceNodeIds"],
    ),
    defineTool("edit_image", "调用现有图片编辑链路，必须提供至少一个真实图片来源节点；图片按 sourceNodeIds 顺序编号。", { prompt: STRING, title: STRING, sourceNodeIds: STRING_ARRAY, size: STRING, count: { type: "integer", minimum: 1, maximum: 15 } }, ["prompt", "sourceNodeIds"]),
    defineTool(
        "generate_video",
        "调用现有视频任务链路。sourceNodeIds 只放真实直接来源，独立生成必须传空数组；其中图片、视频、音频分别按各自顺序编号。",
        {
            prompt: STRING,
            title: STRING,
            sourceNodeIds: STRING_ARRAY,
            size: STRING,
            seconds: { type: "integer", minimum: -1, maximum: 30 },
            generateAudio: { type: "boolean" },
        },
        ["prompt", "sourceNodeIds"],
    ),
    defineTool("generate_audio", "调用现有音频任务链路。prompt 是实际朗读文本，instructions 是音色/演绎说明；sourceNodeIds 只放真实直接来源，独立生成必须传空数组。", { prompt: STRING, title: STRING, sourceNodeIds: STRING_ARRAY, voice: STRING, instructions: STRING }, ["prompt", "sourceNodeIds"]),
    defineTool("create_media_node", "把 MCP 或其他外部工具返回的稳定图片、视频或音频 URL 直接落到画布。content 必须是可访问 URL 或 data URL。", { mediaType: { type: "string", enum: ["image", "video", "audio"] }, content: STRING, title: STRING, sourceNodeIds: STRING_ARRAY }, ["mediaType", "content"]),
    defineTool("get_media_task_status", "读取图片、视频或音频节点的生成状态。", { nodeId: STRING }, ["nodeId"]),
];

export const CANVAS_AGENT_SKILL_FILE_TOOL = defineTool("read_skill_file", "按相对路径读取当前激活系统 Skill 的附属 Markdown 或文本文件。仅当 SKILL.md 明确引用附属文件时使用。", { skillId: STRING, path: STRING }, ["skillId", "path"]);

export function canvasAgentToolDefinition(name: string, toolDefinitions?: CanvasAgentToolDefinition[]) {
    const definitions = toolDefinitions || [...CANVAS_AGENT_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL];
    return definitions.find((tool) => tool.function.name === name);
}

export function normalizeCanvasAgentAction(name: unknown, args: unknown, id = nanoid(), toolDefinitions?: CanvasAgentToolDefinition[]): CanvasAgentAction {
    if (typeof name !== "string" || !name.trim()) throw new Error("模型返回了不允许的工具");
    const actionName = name.trim();
    const definition = canvasAgentToolDefinition(actionName, toolDefinitions);
    if (!definition) throw new Error("模型返回了不允许的工具：" + actionName);
    const input = args === undefined ? {} : args;
    if (!isRecord(input)) throw new Error(actionName + " 的 arguments 必须是对象");
    validateToolArguments(definition.function.parameters, input, actionName);

    let normalized: Record<string, unknown> = {};
    switch (actionName) {
        case "get_canvas_summary":
        case "get_selected_nodes":
        case "get_generation_config":
            break;
        case "query_canvas_nodes": {
            const nodeType = optionalString(input.type);
            if (nodeType && !NODE_TYPES.includes(nodeType)) throw new Error("无效的节点类型");
            normalized = {
                ...(optionalString(input.nodeId) ? { nodeId: optionalString(input.nodeId) } : {}),
                ...(optionalString(input.keyword) ? { keyword: optionalString(input.keyword) } : {}),
                ...(nodeType ? { type: nodeType } : {}),
                page: boundedInteger(input.page, 1, Number.MAX_SAFE_INTEGER) || 1,
                pageSize: boundedInteger(input.pageSize, 1, 50) || 20,
            };
            break;
        }
        case "get_node":
        case "get_upstream_nodes":
        case "get_downstream_nodes":
        case "get_connected_nodes":
        case "get_generation_task":
        case "get_media_task_status":
        case "delete_node":
            normalized = { nodeId: requiredString(input.nodeId, "nodeId") };
            break;
        case "read_skill_file":
            normalized = { skillId: requiredString(input.skillId, "skillId"), path: requiredString(input.path, "path") };
            break;
        case "delete_connection":
            normalized = { connectionId: requiredString(input.connectionId, "connectionId") };
            break;
        case "create_connection":
            normalized = { fromNodeId: requiredString(input.fromNodeId, "fromNodeId"), toNodeId: requiredString(input.toNodeId, "toNodeId") };
            break;
        case "create_primary_script_node":
            normalized = { title: requiredString(input.title, "title"), content: requiredString(input.content, "content"), sourceNodeIds: stringArray(input.sourceNodeIds), projectTitle: requiredString(input.projectTitle, "projectTitle") };
            break;
        case "create_text_node":
            normalized = { title: requiredString(input.title, "title"), content: requiredString(input.content, "content"), sourceNodeIds: stringArray(input.sourceNodeIds) };
            break;
        case "update_text_node": {
            const title = optionalString(input.title);
            const content = optionalString(input.content);
            if (!title && !content) throw new Error("update_text_node 缺少 title 或 content");
            normalized = { nodeId: requiredString(input.nodeId, "nodeId"), ...(title ? { title } : {}), ...(content ? { content } : {}) };
            break;
        }
        case "update_node":
            normalized = { nodeId: requiredString(input.nodeId, "nodeId"), title: requiredString(input.title, "title") };
            break;
        case "set_agent_state": {
            const phase = requiredString(input.phase, "phase") as CanvasAgentPhase;
            if (!PHASES.includes(phase)) throw new Error("无效的 Agent 创作阶段");
            normalized = {
                phase,
                ...(input.brief !== undefined ? { brief: optionalString(input.brief) } : {}),
                ...(input.targetDurationSeconds !== undefined ? { targetDurationSeconds: positiveNumber(input.targetDurationSeconds) } : {}),
                ...(input.approvedPlan !== undefined ? { approvedPlan: optionalString(input.approvedPlan) } : {}),
                ...(input.approvedNodeIds !== undefined ? { approvedNodeIds: stringArray(input.approvedNodeIds) } : {}),
                ...(input.referenceNodeIds !== undefined ? { referenceNodeIds: stringArray(input.referenceNodeIds) } : {}),
            };
            break;
        }
        case "create_group": {
            const nodeIds = stringArray(input.nodeIds);
            if (nodeIds.length < 2) throw new Error("create_group 至少需要两个节点");
            normalized = { nodeIds, ...(input.title !== undefined ? { title: optionalString(input.title) } : {}) };
            break;
        }
        case "arrange_nodes":
            normalized = { nodeIds: stringArray(input.nodeIds) };
            break;
        case "generate_image":
        case "edit_image": {
            const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
            normalized = {
                prompt: requiredString(input.prompt, "prompt"),
                ...(sourceNodeIds ? { sourceNodeIds } : {}),
                ...(input.title !== undefined ? { title: optionalString(input.title) } : {}),
                ...(input.size !== undefined ? { size: optionalString(input.size) } : {}),
                ...(input.count !== undefined ? { count: boundedInteger(input.count, 1, 15) } : {}),
            };
            if (actionName === "edit_image" && sourceNodeIds && !sourceNodeIds.length) throw new Error("edit_image 缺少图片来源节点");
            break;
        }
        case "generate_video": {
            const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
            normalized = {
                prompt: requiredString(input.prompt, "prompt"),
                ...(sourceNodeIds ? { sourceNodeIds } : {}),
                ...(input.title !== undefined ? { title: optionalString(input.title) } : {}),
                ...(input.size !== undefined ? { size: optionalString(input.size) } : {}),
                ...(input.seconds !== undefined ? { seconds: boundedInteger(input.seconds, -1, 30) } : {}),
                ...(input.generateAudio !== undefined ? { generateAudio: input.generateAudio } : {}),
            };
            break;
        }
        case "generate_audio": {
            const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
            normalized = {
                prompt: requiredString(input.prompt, "prompt"),
                ...(sourceNodeIds ? { sourceNodeIds } : {}),
                ...(input.title !== undefined ? { title: optionalString(input.title) } : {}),
                ...(input.voice !== undefined ? { voice: optionalString(input.voice) } : {}),
                ...(input.instructions !== undefined ? { instructions: optionalString(input.instructions) } : {}),
            };
            break;
        }
        case "create_media_node": {
            const mediaType = requiredString(input.mediaType, "mediaType");
            const content = requiredString(input.content, "content");
            const dataPrefix = content.match(/^data:(image|video|audio)\//i)?.[1]?.toLowerCase();
            if (!/^https?:\/\//i.test(content) && !dataPrefix) throw new Error("content 必须是 http(s) 或 data URL");
            if (dataPrefix && dataPrefix !== mediaType) throw new Error("data URL 类型必须与 mediaType 一致");
            normalized = { mediaType, content, ...(input.title !== undefined ? { title: optionalString(input.title) } : {}), sourceNodeIds: stringArray(input.sourceNodeIds) };
            break;
        }
        default:
            normalized = { ...input };
    }

    return { id, name: actionName, arguments: normalized };
}

export async function parseCanvasAgentJson(content: string, { allowRepair = false, tools }: { allowRepair?: boolean; tools?: CanvasAgentToolDefinition[] } = {}): Promise<ParsedCanvasAgentJson> {
    const source = stripJsonFence(content);
    const actionPayload = /(?:^|[,{]\s*)["']?actions["']?\s*:/.test(source);
    const extracted = extractJsonObject(source);
    if (!extracted.json) {
        if (actionPayload) return { parsed: false, actions: [], reply: "", error: "JSON 根对象不完整，本批操作未执行" };
        return { parsed: false, actions: [], reply: content.trim() };
    }
    if (!extracted.complete) {
        if (actionPayload) return { parsed: false, actions: [], reply: "", error: "JSON 输出被截断，本批操作未执行" };
        return { parsed: false, actions: [], reply: content.trim() };
    }

    try {
        let payload: unknown;
        try {
            payload = JSON.parse(extracted.json);
        } catch {
            if (!allowRepair) throw new Error("工具 JSON 不是合法 JSON");
            const sourceStructure = inspectJsonStructure(extracted.json);
            if (!sourceStructure.complete || !sourceStructure.rootObject) throw new Error("JSON 根对象不完整，本批操作未执行");
            const { jsonrepair } = await import("jsonrepair");
            const repaired = jsonrepair(extracted.json);
            const repairedStructure = inspectJsonStructure(repaired);
            if (!repairedStructure.complete || !repairedStructure.rootObject || repairedStructure.tokens !== sourceStructure.tokens) throw new Error("JSON 修复改变了操作结构，本批操作未执行");
            payload = JSON.parse(repaired);
        }
        if (!isRecord(payload) || !Object.prototype.hasOwnProperty.call(payload, "actions")) {
            if (allowRepair || actionPayload) throw new Error("JSON 根对象必须包含 actions 数组");
            const reply = isRecord(payload) && typeof payload.reply === "string" ? payload.reply.trim() : content.trim();
            return { parsed: false, actions: [], reply };
        }
        if (!Array.isArray(payload.actions)) throw new Error("actions 必须是数组");
        if (payload.actions.length > 12) throw new Error("单次最多执行 12 个画布操作，请拆分调用");
        const outerKeys = Object.keys(payload).filter((key) => key !== "actions" && key !== "reply");
        if (outerKeys.length) throw new Error("JSON 外层不支持字段：" + outerKeys.join("、") + "；工具参数必须放在对应 action 的 arguments 中");
        const actions = payload.actions.map((item) => {
            if (!isRecord(item)) throw new Error("actions 中的每项必须是工具调用对象");
            const name = item.tool || item.name;
            if (item.tool !== undefined && item.name !== undefined && item.tool !== item.name) throw new Error("工具调用的 tool 与 name 不一致");
            const misplacedKeys = Object.keys(item).filter((key) => !["id", "tool", "name", "arguments"].includes(key));
            let args = item.arguments;
            if (misplacedKeys.length) {
                if (typeof name !== "string") throw new Error("模型返回了不允许的工具");
                if (args !== undefined && !isRecord(args)) throw new Error(name + " 的 arguments 必须是对象");
                const supported = canvasAgentToolDefinition(name, tools)?.function.parameters.properties;
                if (!supported) throw new Error("模型返回了不允许的工具：" + name);
                const unsupported = misplacedKeys.filter((key) => !Object.prototype.hasOwnProperty.call(supported, key));
                if (unsupported.length) throw new Error(name + " 不支持参数：" + unsupported.join("、"));
                const normalizedArgs = { ...(isRecord(args) ? args : {}) };
                const conflicts = misplacedKeys.filter((key) => Object.prototype.hasOwnProperty.call(normalizedArgs, key));
                if (conflicts.length) throw new Error(conflicts.join("、") + " 同时出现在 arguments 内外层");
                misplacedKeys.forEach((key) => {
                    normalizedArgs[key] = item[key];
                });
                args = normalizedArgs;
            }
            return normalizeCanvasAgentAction(name, args, typeof item.id === "string" && item.id ? item.id : nanoid(), tools);
        });
        return { parsed: true, actions, reply: typeof payload.reply === "string" ? payload.reply.trim() : "" };
    } catch (error) {
        if (actionPayload || allowRepair) return { parsed: false, actions: [], reply: "", error: error instanceof Error ? error.message : "工具 JSON 格式错误" };
        return { parsed: false, actions: [], reply: content.trim() };
    }
}

export function canvasAgentActionLabel(action: CanvasAgentAction) {
    const labels: Record<CanvasAgentActionName, string> = {
        get_canvas_summary: "正在读取画布",
        get_selected_nodes: "正在读取选中节点",
        query_canvas_nodes: "正在查找画布节点",
        get_node: "正在读取节点",
        get_upstream_nodes: "正在读取上游节点",
        get_downstream_nodes: "正在读取下游节点",
        get_connected_nodes: "正在读取关联节点",
        get_generation_config: "正在读取生成配置",
        get_generation_task: "正在读取任务状态",
        set_agent_state: "正在保存创作进度",
        create_primary_script_node: "正在创建主剧本节点",
        create_text_node: "正在创建文本节点",
        update_text_node: "正在更新文本节点",
        update_node: "正在更新节点",
        delete_node: "正在删除节点",
        create_connection: "正在创建连线",
        delete_connection: "正在删除连线",
        create_group: "正在创建分组",
        arrange_nodes: "正在整理画布",
        generate_image: "正在创建图片节点",
        edit_image: "正在创建图片编辑节点",
        generate_video: "正在创建视频节点",
        generate_audio: "正在创建音频节点",
        create_media_node: "正在把外部媒体放入画布",
        get_media_task_status: "正在读取媒体任务",
    };
    return labels[action.name as CanvasAgentActionName] || "正在调用外部工具";
}

export function isCanvasAgentMediaAction(action: CanvasAgentAction) {
    return action.name === "generate_image" || action.name === "edit_image" || action.name === "generate_video" || action.name === "generate_audio";
}

export function userLikelyRequestedCanvasAction(text: string) {
    return /(?:创建|新增|插入|修改|更新|删除|连接|连线|分组|整理|生成|生图|执行|拆成|拆分|放到画布|开始做|(?:做|制作|添加|补充|移除|去掉).{0,8}(?:视频|音频|配音|旁白))/i.test(text);
}

function extractJsonObject(content: string) {
    const trimmed = content.trim();
    if (trimmed.startsWith("[")) return { json: trimmed, complete: false };
    const start = trimmed.indexOf("{");
    if (start < 0) return { json: "", complete: false };
    const candidate = trimmed.slice(start);
    const structure = inspectJsonStructure(candidate);
    if (!structure.complete || structure.rootEnd < 0) return { json: candidate, complete: false };
    return { json: candidate.slice(0, structure.rootEnd + 1), complete: true };
}

function stripJsonFence(content: string) {
    return content.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "").trim();
}

function inspectJsonStructure(value: string) {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return { complete: false, rootObject: false, tokens: "", rootEnd: -1 };
    const stack: string[] = [];
    let quote = "";
    let escaped = false;
    let tokens = "";
    let rootEnd = -1;
    for (let index = 0; index < trimmed.length; index++) {
        const char = trimmed[index];
        if (rootEnd >= 0) continue;
        if (quote) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === "{" || char === "[") {
            stack.push(char);
            tokens += char;
            continue;
        }
        if (char !== "}" && char !== "]") continue;
        tokens += char;
        const open = stack.pop();
        if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) return { complete: false, rootObject: true, tokens, rootEnd: -1 };
        if (!stack.length) rootEnd = index;
    }
    return { complete: rootEnd >= 0 && !quote && !stack.length, rootObject: true, tokens, rootEnd };
}

function validateToolArguments(schema: Record<string, unknown>, value: Record<string, unknown>, toolName: string) {
    validateSchemaValue(value, schema, toolName);
}

function validateSchemaValue(value: unknown, schema: Record<string, unknown>, path: string): void {
    if (schema.nullable === true && value === null) return;
    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) throw new Error(path + " 的值不在允许范围内");
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some((candidate) => isRecord(candidate) && canValidate(value, candidate, path))) throw new Error(path + " 的参数类型不正确");
    if (Array.isArray(schema.oneOf) && schema.oneOf.filter((candidate) => isRecord(candidate) && canValidate(value, candidate, path)).length !== 1) throw new Error(path + " 的参数类型不正确");

    const type = schema.type;
    if (Array.isArray(type)) {
        if (!type.some((item) => typeof item === "string" && matchesJsonType(value, item))) throw new Error(path + " 的参数类型不正确");
    } else if (typeof type === "string" && !matchesJsonType(value, type)) {
        throw new Error(path + " 必须是 " + type);
    }

    if (typeof value === "string") {
        if (typeof schema.minLength === "number" && value.length < schema.minLength) throw new Error(path + " 长度过短");
        if (typeof schema.maxLength === "number" && value.length > schema.maxLength) throw new Error(path + " 长度过长");
        if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) throw new Error(path + " 格式不正确");
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error(path + " 必须是有限数字");
        if (typeof schema.minimum === "number" && value < schema.minimum) throw new Error(path + " 不能小于 " + schema.minimum);
        if (typeof schema.maximum === "number" && value > schema.maximum) throw new Error(path + " 不能大于 " + schema.maximum);
    }
    if (Array.isArray(value)) {
        if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new Error(path + " 至少需要 " + schema.minItems + " 项");
        if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(path + " 最多允许 " + schema.maxItems + " 项");
        if (isRecord(schema.items)) value.forEach((item, index) => validateSchemaValue(item, schema.items as Record<string, unknown>, path + "[" + index + "]"));
    }
    if (isRecord(value)) {
        const properties = isRecord(schema.properties) ? schema.properties : {};
        const required = Array.isArray(schema.required) ? schema.required : [];
        for (const key of required) {
            if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) throw new Error(path + " 的 arguments 缺少必填参数：" + key);
        }
        for (const [key, item] of Object.entries(value)) {
            if (Object.prototype.hasOwnProperty.call(properties, key)) {
                if (isRecord(properties[key])) validateSchemaValue(item, properties[key] as Record<string, unknown>, path + "." + key);
                continue;
            }
            if (schema.additionalProperties === false) throw new Error(path + " 不支持参数：" + key);
            if (isRecord(schema.additionalProperties)) validateSchemaValue(item, schema.additionalProperties as Record<string, unknown>, path + "." + key);
        }
    }
}

function canValidate(value: unknown, schema: Record<string, unknown>, path: string) {
    try {
        validateSchemaValue(value, schema, path);
        return true;
    } catch {
        return false;
    }
}

function matchesJsonType(value: unknown, type: string) {
    switch (type) {
        case "object":
            return isRecord(value);
        case "array":
            return Array.isArray(value);
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "integer":
            return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
        case "boolean":
            return typeof value === "boolean";
        case "null":
            return value === null;
        default:
            return true;
    }
}

function requiredString(value: unknown, key: string) {
    if (typeof value !== "string") throw new Error(key + " 必须是字符串");
    const text = value.trim();
    if (!text) throw new Error(key + " 不能为空");
    return text;
}

function optionalString(value: unknown) {
    if (value === undefined) return "";
    if (typeof value !== "string") throw new Error("可选文本参数必须是字符串");
    return value.trim();
}

function stringArray(value: unknown, key = "节点 ID") {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(key + " 必须是字符串数组");
    if (value.length > 50) throw new Error(key + " 数组最多允许 50 项，请拆分调用");
    return [...new Set(value.map((item) => {
        if (typeof item !== "string" || !item.trim()) throw new Error(key + " 必须是字符串数组");
        return item.trim();
    }))];
}

function optionalStringArray(value: unknown, key: string) {
    if (value === undefined) return undefined;
    return stringArray(value, key);
}

function positiveNumber(value: unknown) {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) throw new Error("数值必须是大于等于 1 的数字");
    return value;
}

function boundedInteger(value: unknown, min: number, max: number) {
    const number = boundedNumber(value, min, max);
    if (number !== undefined && !Number.isInteger(number)) throw new Error("数值必须是整数");
    return number;
}

function boundedNumber(value: unknown, min: number, max: number) {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("数值必须在 " + min + " 到 " + max + " 之间");
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
