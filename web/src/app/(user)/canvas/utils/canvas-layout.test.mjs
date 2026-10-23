import assert from "node:assert/strict";
import test from "node:test";
import { CANVAS_ARRANGE_GAP, arrangeCanvasNodes, snapNodesToCanvasGrid, snapToCanvasGrid } from "./canvas-layout.ts";

const node = (id, position, extra = {}) => ({ id, type: extra.type || "image", title: id, position, width: extra.width || 100, height: extra.height || 80, metadata: extra.metadata });

test("网格吸附按步长取整，负坐标向最近格点取整", () => {
    assert.deepEqual(snapToCanvasGrid({ x: 50, y: 20 }), { x: 48, y: 0 });
    assert.deepEqual(snapToCanvasGrid({ x: 25, y: -50 }), { x: 48, y: -48 });
    assert.deepEqual(snapToCanvasGrid({ x: 0, y: 0 }, 0), { x: 0, y: 0 });
});

test("拖拽落位以主节点左上角吸附，整组保持相对间距", () => {
    const nodes = [node("a", { x: 100, y: 90 }), node("b", { x: 260, y: 180 }), node("ignored", { x: 999, y: 999 })];
    const snapped = snapNodesToCanvasGrid(nodes, new Set(["a", "b"]));
    assert.deepEqual(snapped[0].position, { x: 96, y: 96 });
    assert.deepEqual(snapped[1].position, { x: 256, y: 186 });
    assert.deepEqual(snapped[1].position.x - snapped[0].position.x, 160);
    assert.deepEqual(snapped[2].position, { x: 999, y: 999 });
    assert.deepEqual(nodes[0].position, { x: 100, y: 90 });
});

test("关闭吸附时节点位置保持原样", () => {
    const nodes = [node("a", { x: 100, y: 90 })];
    assert.equal(snapNodesToCanvasGrid(nodes, new Set(["a"]), 0), nodes);
});

test("整理画板按四列网格排列并让组内子节点跟随", () => {
    const nodes = [
        node("n1", { x: 500, y: 400 }),
        node("n2", { x: 100, y: 100 }),
        node("n3", { x: 300, y: 700 }, { width: 200, height: 200 }),
        node("n4", { x: 900, y: 50 }),
        node("n5", { x: 700, y: 650 }),
        node("group", { x: 40, y: 40 }, { type: "group", width: 300, height: 300 }),
        node("child", { x: 120, y: 120 }, { metadata: { groupId: "group" } }),
        node("batchRoot", { x: 800, y: 800 }, { metadata: { isBatchRoot: true } }),
        node("batchChild", { x: 840, y: 840 }, { metadata: { batchRootId: "batchRoot" } }),
    ];
    const arranged = arrangeCanvasNodes(nodes);
    const byId = new Map(arranged.map((item) => [item.id, item]));
    const gap = CANVAS_ARRANGE_GAP;

    assert.deepEqual(byId.get("n1").position, { x: 40, y: 40 });
    assert.deepEqual(byId.get("n2").position, { x: 212, y: 40 });
    assert.deepEqual(byId.get("n3").position, { x: 384, y: 40 });
    assert.deepEqual(byId.get("n4").position, { x: 656, y: 40 });
    assert.deepEqual(byId.get("group").position, { x: 212, y: 312 });
    assert.deepEqual(byId.get("child").position, { x: 292, y: 392 });
    assert.deepEqual(byId.get("n5").position, { x: 40, y: 312 });
    assert.deepEqual(byId.get("batchRoot").position, { x: 584, y: 312 });
    assert.deepEqual(byId.get("batchChild").position, { x: 624, y: 352 });
    assert.deepEqual(
        {
            dx: byId.get("batchChild").position.x - byId.get("batchRoot").position.x,
            dy: byId.get("batchChild").position.y - byId.get("batchRoot").position.y,
        },
        { dx: 40, dy: 40 },
    );
    assert.deepEqual(nodes[0].position, { x: 500, y: 400 });
});

test("整理画板仅凭 batchChildIds 声明也会让批量子节点跟随", () => {
    const nodes = [
        node("other", { x: 100, y: 100 }),
        node("root", { x: 800, y: 800 }, { metadata: { isBatchRoot: true, batchChildIds: ["child"] } }),
        node("child", { x: 840, y: 840 }),
    ];
    const arranged = arrangeCanvasNodes(nodes);
    const byId = new Map(arranged.map((item) => [item.id, item]));

    assert.deepEqual(byId.get("root").position, { x: 272, y: 100 });
    assert.deepEqual(byId.get("child").position, { x: 312, y: 140 });
});

test("整理画板仅凭 batchRootId 声明也会让批量子节点跟随", () => {
    const nodes = [
        node("other", { x: 100, y: 100 }),
        node("root", { x: 800, y: 800 }, { metadata: { isBatchRoot: true } }),
        node("child", { x: 840, y: 840 }, { metadata: { batchRootId: "root" } }),
    ];
    const arranged = arrangeCanvasNodes(nodes);
    const byId = new Map(arranged.map((item) => [item.id, item]));

    assert.deepEqual(byId.get("root").position, { x: 272, y: 100 });
    assert.deepEqual(byId.get("child").position, { x: 312, y: 140 });
    assert.deepEqual(
        {
            dx: byId.get("child").position.x - byId.get("root").position.x,
            dy: byId.get("child").position.y - byId.get("root").position.y,
        },
        { dx: 40, dy: 40 },
    );
});

test("整理画板时组节点与批次根节点各自跟随自己的子节点", () => {
    const nodes = [
        node("group", { x: 40, y: 40 }, { type: "group", width: 200, height: 200 }),
        node("groupChild", { x: 80, y: 80 }, { metadata: { groupId: "group" } }),
        node("batchRoot", { x: 800, y: 800 }, { metadata: { isBatchRoot: true, batchChildIds: ["batchChild"] } }),
        node("batchChild", { x: 840, y: 840 }, { metadata: { batchRootId: "batchRoot" } }),
    ];
    const arranged = arrangeCanvasNodes(nodes);
    const byId = new Map(arranged.map((item) => [item.id, item]));

    assert.deepEqual(byId.get("group").position, { x: 40, y: 40 });
    assert.deepEqual(byId.get("groupChild").position, { x: 80, y: 80 });
    assert.deepEqual(byId.get("batchRoot").position, { x: 312, y: 40 });
    assert.deepEqual(byId.get("batchChild").position, { x: 352, y: 80 });
    assert.deepEqual(
        {
            dx: byId.get("batchChild").position.x - byId.get("batchRoot").position.x,
            dy: byId.get("batchChild").position.y - byId.get("batchRoot").position.y,
        },
        { dx: 40, dy: 40 },
    );
});

test("整理画板时双向声明的批量子节点只平移一次", () => {
    const nodes = [
        node("other", { x: 100, y: 100 }),
        node("root", { x: 800, y: 800 }, { metadata: { isBatchRoot: true, batchChildIds: ["child", "child"] } }),
        node("child", { x: 840, y: 840 }, { metadata: { batchRootId: "root" } }),
    ];
    const arranged = arrangeCanvasNodes(nodes);
    const byId = new Map(arranged.map((item) => [item.id, item]));

    assert.deepEqual(byId.get("child").position, { x: 312, y: 140 });
});
