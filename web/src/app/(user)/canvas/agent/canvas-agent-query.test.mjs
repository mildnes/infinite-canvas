import assert from "node:assert/strict";
import test from "node:test";

import { queryCanvasNodes } from "./canvas-agent-query.ts";

test("按关键词和类型查询真实画布节点", () => {
    const context = {
        nodes: [
            { id: "text-1", type: "text", title: "第一幕分镜", text: "雨夜开场" },
            { id: "image-1", type: "image", title: "角色参考", prompt: "red coat" },
        ],
    };
    const result = queryCanvasNodes(context, { keyword: "雨夜", type: "text" });

    assert.equal(result.ok, true);
    assert.equal(result.total, 1);
    assert.deepEqual(result.nodes, [context.nodes[0]]);
});
