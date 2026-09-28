import assert from "node:assert/strict";
import test from "node:test";

import { mergeCanvasAgentToolCallFragments } from "./canvas-agent.ts";

test("流式工具调用按 index 合并名称和参数片段", () => {
    assert.deepEqual(
        mergeCanvasAgentToolCallFragments([
            { index: 0, id: "call-1", function: { name: "create_", arguments: '{"prompt":"' } },
            { index: "0", function: { name: "text_node", arguments: "hello" } },
            { index: 0, function: { arguments: '"}' } },
            { index: 1, id: "call-2", function: { name: "delete_node", arguments: '{"nodeId":"n1"}' } },
        ]),
        [
            { id: "call-1", function: { name: "create_text_node", arguments: '{"prompt":"hello"}' } },
            { id: "call-2", function: { name: "delete_node", arguments: '{"nodeId":"n1"}' } },
        ],
    );
});

test("流式工具调用忽略非字符串字段，不把对象拼成 [object Object]", () => {
    assert.deepEqual(
        mergeCanvasAgentToolCallFragments([{ index: 0, function: { name: { invalid: true }, arguments: { invalid: true } } }]),
        [{ function: { name: "", arguments: "" } }],
    );
});
