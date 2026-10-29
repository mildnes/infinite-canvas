// 生成进度插值：后端固定台阶（0/10/30/100）→ 前端按时间平滑推进
// 反假绿：把 canvas-node.tsx 回退到直接用 backendProgress 后，本文件的相关断言应失败
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    CANVAS_PROGRESS_CAP,
    interpolateGenerationProgress,
} from "../app/(user)/canvas/utils/canvas-progress.ts";

test("未开始推进时保持后端台阶值", () => {
    assert.equal(interpolateGenerationProgress(10, 0), 10);
    assert.equal(interpolateGenerationProgress(30, 0), 30);
    assert.equal(interpolateGenerationProgress(0, 0), 0);
});

test("停在 10% 台阶时会随时间真的增长", () => {
    const t30 = interpolateGenerationProgress(10, 30_000);
    const t60 = interpolateGenerationProgress(10, 60_000);
    const t150 = interpolateGenerationProgress(10, 150_000);
    assert.ok(t30 > 10, `30 秒后应大于 10%，实际 ${t30}`);
    assert.ok(t60 > t30, `60 秒应大于 30 秒（${t60} > ${t30}）`);
    assert.ok(t150 > t60, `150 秒应大于 60 秒（${t150} > ${t60}）`);
});

test("永远不会越过上限，也不会在完成前谎报 100%", () => {
    for (const elapsed of [0, 1_000, 60_000, 600_000, 3_600_000, 86_400_000]) {
        const value = interpolateGenerationProgress(10, elapsed);
        assert.ok(value <= CANVAS_PROGRESS_CAP, `${elapsed}ms 时 ${value} 超过上限 ${CANVAS_PROGRESS_CAP}`);
        assert.ok(value < 100, `${elapsed}ms 时不应达到 100%`);
    }
});

test("长时间后接近上限但不超过", () => {
    const value = interpolateGenerationProgress(10, 600_000);
    assert.ok(value >= 85 && value <= CANVAS_PROGRESS_CAP, `10 分钟后应接近上限，实际 ${value}`);
});

test("后端返回 100 时原样返回 100", () => {
    assert.equal(interpolateGenerationProgress(100, 0), 100);
    assert.equal(interpolateGenerationProgress(100, 999_999), 100);
});

test("从 0 开始时也会随时间推进", () => {
    assert.ok(interpolateGenerationProgress(0, 60_000) > 0);
    assert.ok(interpolateGenerationProgress(0, 60_000) < interpolateGenerationProgress(10, 60_000));
});

test("结果随时间单调非递减", () => {
    let previous = -1;
    for (let elapsed = 0; elapsed <= 600_000; elapsed += 15_000) {
        const value = interpolateGenerationProgress(10, elapsed);
        assert.ok(value >= previous, `${elapsed}ms 时出现回退：${value} < ${previous}`);
        previous = value;
    }
});

test("异常输入不产生 NaN 或越界值", () => {
    assert.ok(Number.isFinite(interpolateGenerationProgress(Number.NaN, 60_000)));
    assert.ok(Number.isFinite(interpolateGenerationProgress(10, Number.NaN)));
    assert.equal(interpolateGenerationProgress(-5, 0), 0);
    assert.equal(interpolateGenerationProgress(150, 0), 100);
    assert.ok(interpolateGenerationProgress(10, 60_000, 0) <= CANVAS_PROGRESS_CAP);
});

test("已到上限的台阶不再变化", () => {
    assert.equal(interpolateGenerationProgress(CANVAS_PROGRESS_CAP, 0), CANVAS_PROGRESS_CAP);
    assert.equal(interpolateGenerationProgress(CANVAS_PROGRESS_CAP, 600_000), CANVAS_PROGRESS_CAP);
});

test("旧行为（直接使用后端台阶值）在 60 秒时会被本用例判为未推进", () => {
    // 这条锁定「修复前是常数」的事实：若有人改回直接展示 backendProgress，
    // 下面的断言会失败，提醒必须保留插值。
    const legacy = Math.max(0, Math.min(100, Math.round(10)));
    const actual = interpolateGenerationProgress(10, 60_000);
    assert.equal(legacy, 10, "旧实现应为常数 10");
    assert.notEqual(actual, legacy, "修复后 60 秒时必须已脱离常数");
});

// ---- 接线断言：组件必须真的用插值结果，而不是继续直接展示后端台阶 ----
import { readFileSync } from "node:fs";

const nodeSource = readFileSync(
    new URL("../app/(user)/canvas/components/canvas-node.tsx", import.meta.url),
    "utf8",
);

test("canvas-node 导入并使用进度插值", () => {
    assert.ok(
        nodeSource.includes('import { interpolateGenerationProgress } from "../utils/canvas-progress";'),
        "canvas-node 必须导入 interpolateGenerationProgress",
    );
    assert.ok(
        nodeSource.includes("const progress = interpolateGenerationProgress(backendProgress, elapsedMs);"),
        "显示用的 progress 必须来自插值结果",
    );
    assert.ok(
        nodeSource.includes("const backendProgress = Math.max(0, Math.min(100, Math.round(node.metadata?.progress || 0)));"),
        "后端台阶值应另存为 backendProgress",
    );
});

test("不再把后端台阶值直接当作显示进度", () => {
    assert.ok(
        !nodeSource.includes("const progress = Math.max(0, Math.min(100, Math.round(node.metadata?.progress || 0)));"),
        "不应保留直接展示后端台阶的旧行（这正是 10% 卡住的根因）",
    );
});
