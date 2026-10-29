import assert from "node:assert/strict";
import test from "node:test";
import { calculateCanvasAlignment, createCanvasAlignmentContext } from "./canvas-alignment.ts";

const node = (id, position, extra = {}) => ({
    id,
    type: extra.type || "image",
    title: id,
    position,
    width: extra.width || 100,
    height: extra.height || 80,
    metadata: extra.metadata,
});

test("左边、上边接近时分别显示对应辅助线并修正偏移", () => {
    const context = createCanvasAlignmentContext([
        node("moving", { x: 10, y: 20 }),
        node("target", { x: 100, y: 300 }),
    ], new Set(["moving"]));

    const result = calculateCanvasAlignment(context, { x: 88, y: 276 }, 5);

    assert.deepEqual(result.offset, { x: 90, y: 280 });
    assert.deepEqual(result.guides, { vertical: 100, horizontal: 300 });
});

test("中心和右边对齐使用对应锚点", () => {
    const centerContext = createCanvasAlignmentContext([
        node("moving", { x: 10, y: 20 }),
        node("target", { x: 220, y: 300 }, { width: 80, height: 60 }),
    ], new Set(["moving"]));
    const center = calculateCanvasAlignment(centerContext, { x: 197, y: 0 }, 5);
    assert.deepEqual(center.offset, { x: 200, y: 0 });
    assert.equal(center.guides.vertical, 260);

    const rightContext = createCanvasAlignmentContext([
        node("moving", { x: 10, y: 20 }),
        node("target", { x: 220, y: 300 }, { width: 80, height: 60 }),
    ], new Set(["moving"]));
    const right = calculateCanvasAlignment(rightContext, { x: 186, y: 0 }, 5);
    assert.deepEqual(right.offset, { x: 190, y: 0 });
    assert.equal(right.guides.vertical, 300);
});

test("超出阈值不吸附，移动节点也不会成为自己的目标", () => {
    const nodes = [node("moving", { x: 10, y: 20 }), node("target", { x: 200, y: 300 })];
    const context = createCanvasAlignmentContext(nodes, new Set(["moving"]));
    const result = calculateCanvasAlignment(context, { x: 20, y: 10 }, 5);

    assert.deepEqual(result.offset, { x: 20, y: 10 });
    assert.deepEqual(result.guides, {});
    assert.deepEqual(nodes[0].position, { x: 10, y: 20 });
});

test("多选节点按整体边界对齐并保持相对间距", () => {
    const nodes = [
        node("moving-a", { x: 10, y: 20 }, { width: 100, height: 80 }),
        node("moving-b", { x: 200, y: 120 }, { width: 50, height: 40 }),
        node("target", { x: 400, y: 300 }, { width: 100, height: 80 }),
    ];
    const context = createCanvasAlignmentContext(nodes, new Set(["moving-a", "moving-b"]));
    const result = calculateCanvasAlignment(context, { x: 390, y: 0 }, 5);

    assert.deepEqual(result.offset, { x: 390, y: 0 });
    assert.equal(result.guides.vertical, 400);
});

test("负坐标和缩放后的阈值仍按世界坐标计算", () => {
    const context = createCanvasAlignmentContext([
        node("moving", { x: -120, y: -80 }),
        node("target", { x: -10, y: 200 }),
    ], new Set(["moving"]));
    const result = calculateCanvasAlignment(context, { x: 107, y: 0 }, 7 / 2);

    assert.deepEqual(result.offset, { x: 110, y: 0 });
    assert.equal(result.guides.vertical, -10);
});
