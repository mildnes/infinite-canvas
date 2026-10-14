import assert from "node:assert/strict";
import test from "node:test";

import { resolveMissingTaskOutcome } from "./workbench-task-sync.ts";

const now = 1_000_000;

test("已有图片结果保持成功", () => {
    assert.deepEqual(resolveMissingTaskOutcome({ hasImages: true, createdAt: 0, now }), { status: "success" });
});

test("没有图片但未超过30分钟时保持等待", () => {
    assert.deepEqual(resolveMissingTaskOutcome({ hasImages: false, createdAt: now - 29 * 60 * 1000, now }), { status: "pending" });
});

test("没有图片且超过30分钟时标记任务记录已过期", () => {
    assert.deepEqual(resolveMissingTaskOutcome({ hasImages: false, createdAt: now - 31 * 60 * 1000, now }), {
        status: "failed",
        error: "任务记录已过期（无法确认结果，可重新生成）",
    });
});
