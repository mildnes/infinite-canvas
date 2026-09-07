import assert from "node:assert/strict";
import test from "node:test";

import { CANVAS_AGENT_SKILL_FILE_TOOL, CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction, parseCanvasAgentJson, userLikelyRequestedCanvasAction } from "./canvas-agent-tools.ts";

test("定义节点查询和系统 Skill 文件工具", () => {
    assert.ok(CANVAS_AGENT_TOOLS.some((tool) => tool.function.name === "query_canvas_nodes"));
    assert.equal(CANVAS_AGENT_SKILL_FILE_TOOL.function.name, "read_skill_file");
});

test("规范化节点查询分页参数", () => {
    assert.deepEqual(normalizeCanvasAgentAction("query_canvas_nodes", { keyword: " 分镜 ", page: 2, pageSize: 20 }, "query-1"), {
        id: "query-1",
        name: "query_canvas_nodes",
        arguments: { keyword: "分镜", page: 2, pageSize: 20 },
    });
});

test("普通媒体询问不会误报为画布执行请求", () => {
    assert.equal(userLikelyRequestedCanvasAction("视频和音频有什么区别？"), false);
    assert.equal(userLikelyRequestedCanvasAction("帮我生成一段视频"), true);
});

test("工具参数类型和未知字段会在执行前被拒绝", () => {
    assert.throws(() => normalizeCanvasAgentAction("query_canvas_nodes", { page: "2" }), /必须是 integer|参数类型/);
    assert.throws(() => normalizeCanvasAgentAction("query_canvas_nodes", { unknown: true }), /不支持参数/);
});

test("动态 MCP 工具使用同一套 schema 校验", () => {
    const mcpTool = {
        type: "function",
        function: {
            name: "mcp__demo__echo",
            description: "echo",
            parameters: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
                additionalProperties: false,
            },
        },
    };
    assert.deepEqual(normalizeCanvasAgentAction("mcp__demo__echo", { message: "hello" }, "mcp-1", [...CANVAS_AGENT_TOOLS, mcpTool]), {
        id: "mcp-1",
        name: "mcp__demo__echo",
        arguments: { message: "hello" },
    });
    assert.throws(() => normalizeCanvasAgentAction("mcp__demo__echo", { message: 1 }, "mcp-2", [...CANVAS_AGENT_TOOLS, mcpTool]), /必须是 string|参数类型/);
});

test("JSON 修复只处理完整根对象，且整批校验后才返回动作", async () => {
    const repaired = await parseCanvasAgentJson('{"actions":[{"tool":"get_canvas_summary","arguments":{},}],"reply":"ok",}', { allowRepair: true });
    assert.equal(repaired.parsed, true);
    assert.equal(repaired.actions.length, 1);

    const incomplete = await parseCanvasAgentJson('{"actions":[{"tool":"get_canvas_summary","arguments":{}}', { allowRepair: true });
    assert.equal(incomplete.parsed, false);
    assert.match(incomplete.error || "", /截断|根对象不完整/);

    const invalidBatch = await parseCanvasAgentJson(JSON.stringify({
        actions: [
            { tool: "get_canvas_summary", arguments: {} },
            { tool: "unknown_tool", arguments: {} },
        ],
        reply: "",
    }), { allowRepair: true });
    assert.equal(invalidBatch.parsed, false);
    assert.equal(invalidBatch.actions.length, 0);
});

test("JSON 工具批次超过安全上限时不会截断执行", async () => {
    const result = await parseCanvasAgentJson(JSON.stringify({ actions: Array.from({ length: 13 }, () => ({ tool: "get_canvas_summary", arguments: {} })), reply: "" }), { allowRepair: true });
    assert.equal(result.parsed, false);
    assert.match(result.error || "", /最多执行 12/);
    assert.equal(result.actions.length, 0);
});
