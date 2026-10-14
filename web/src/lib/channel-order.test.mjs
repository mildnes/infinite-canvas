import assert from "node:assert/strict";
import test from "node:test";

import { moveChannel } from "./channel-order.ts";

const base = ["a", "b", "c", "d"];

test("上移：把中间元素与前一位置换", () => {
    assert.deepEqual(moveChannel(base, 2, -1), ["a", "c", "b", "d"]);
});

test("下移：把中间元素与后一位置换", () => {
    assert.deepEqual(moveChannel(base, 1, 1), ["a", "c", "b", "d"]);
});

test("首项上移是空操作（越界保护）", () => {
    assert.deepEqual(moveChannel(base, 0, -1), base);
});

test("末项下移是空操作（越界保护）", () => {
    assert.deepEqual(moveChannel(base, base.length - 1, 1), base);
});

test("非法索引与零位移原样返回", () => {
    assert.deepEqual(moveChannel(base, -1, 1), base);
    assert.deepEqual(moveChannel(base, 9, -1), base);
    assert.deepEqual(moveChannel(base, 1, 0), base);
    assert.deepEqual(moveChannel(base, 1.5, 1), base);
});

test("不修改入参（保持不可变，便于 React setState）", () => {
    const input = [...base];
    const next = moveChannel(input, 0, 1);
    assert.deepEqual(input, base, "原数组必须保持不变");
    assert.notEqual(next, input, "应返回新数组");
    assert.deepEqual(next, ["b", "a", "c", "d"]);
});

test("元素个数与集合不变（只换位置，不增删）", () => {
    const next = moveChannel(base, 0, 3);
    assert.equal(next.length, base.length);
    assert.deepEqual([...next].sort(), [...base].sort());
});

test("对对象数组同样可用（按渠道对象整体移动）", () => {
    const channels = [
        { id: "banana", name: "香蕉" },
        { id: "official4k", name: "官方4K" },
        { id: "native4k", name: "原生4K" },
    ];
    const next = moveChannel(channels, 2, -1);
    assert.deepEqual(next.map((item) => item.id), ["banana", "native4k", "official4k"]);
});
