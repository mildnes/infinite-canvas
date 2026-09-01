import assert from "node:assert/strict";
import test from "node:test";

import { CANVAS_AGENT_SKILL_FILE_TOOL, CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction, userLikelyRequestedCanvasAction } from "./canvas-agent-tools.ts";

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
