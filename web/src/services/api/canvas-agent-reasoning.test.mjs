import assert from "node:assert/strict";
import test from "node:test";

import { applyCanvasAgentReasoning } from "./canvas-agent-reasoning.ts";

test("关闭推理时不改变请求体", () => {
    const body = { model: "example" };
    assert.deepEqual(applyCanvasAgentReasoning(body, { enabled: false, mode: "chat", model: "example" }), { model: "example" });
});

test("各文本接口使用对应推理参数", () => {
    assert.deepEqual(applyCanvasAgentReasoning({}, { enabled: true, mode: "responses", model: "example" }), { reasoning: { effort: "high" } });
    assert.deepEqual(applyCanvasAgentReasoning({}, { enabled: true, mode: "chat", model: "mimo-v2", protocol: "mimo" }), { thinking: { type: "enabled" } });
    assert.deepEqual(applyCanvasAgentReasoning({}, { enabled: true, mode: "chat", model: "example" }), { reasoning_effort: "high" });
    assert.deepEqual(applyCanvasAgentReasoning({}, { enabled: true, mode: "gemini", model: "gemini-2.5-pro" }), { generationConfig: { thinkingConfig: { thinkingBudget: -1 } } });
    assert.deepEqual(applyCanvasAgentReasoning({ generationConfig: { temperature: 0.2 } }, { enabled: true, mode: "gemini", model: "gemini-3-pro" }), { generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: "high" } } });
});
