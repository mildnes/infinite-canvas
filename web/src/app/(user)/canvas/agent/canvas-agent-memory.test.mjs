import assert from "node:assert/strict";
import test from "node:test";

import { compactCanvasAgentHistory } from "./canvas-agent-memory.ts";

test("压缩旧轮次并保留最近对话", async () => {
    const oldText = "旧目标".repeat(70_000);
    const protocolMessages = [
        { role: "user", content: oldText },
        { role: "assistant", content: "旧轮次完成" },
        { role: "user", content: "继续当前方案" },
        { role: "assistant", content: "当前轮次完成" },
    ];
    const result = await compactCanvasAgentHistory({
        protocolMessages,
        createCheckpoint: async () => "用户已确认旧目标",
    });

    assert.equal(result.compacted, true);
    assert.equal(result.contextCheckpoint, "用户已确认旧目标");
    assert.deepEqual(result.protocolMessages, protocolMessages.slice(2));
});
