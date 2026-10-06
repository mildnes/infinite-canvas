import assert from "node:assert/strict";
import test from "node:test";

import { stripReferenceMetadata } from "./prompt-reference-metadata.ts";

test("图片N（用户本轮图片M，文件名）还原为 图片N", () => {
    const input = "仅局部编辑图片1（用户本轮图片237，CZ场景 1.png）。图片1是唯一场景布局、车阵排布。";
    assert.equal(stripReferenceMetadata(input), "仅局部编辑图片1。图片1是唯一场景布局、车阵排布。");
});

test("多参考职责列表里的双标识全部还原", () => {
    const input = "参考车辆与职责：图片2（用户图片114，7.jpg）、图片3（用户图片160，5860fab8…jpg）、图片4（用户图片217，追光45.png）分别是四款替换车辆的唯一车型身份参考。";
    assert.equal(
        stripReferenceMetadata(input),
        "参考车辆与职责：图片2、图片3、图片4分别是四款替换车辆的唯一车型身份参考。",
    );
});

test("不带文件名的溯源标注同样还原", () => {
    assert.equal(stripReferenceMetadata("图片5（用户图片229）是唯一参考。"), "图片5是唯一参考。");
    assert.equal(stripReferenceMetadata("图片1（用户本轮图片237）保持不变。"), "图片1保持不变。");
});

test("职责说明不被误删", () => {
    const input = "图片1（唯一场景基准）、图片2（左侧 Logo 唯一原件）、图片3（透明亚克力背板）。";
    assert.equal(stripReferenceMetadata(input), input);
});

test("独立的（用户本轮图片M，文件名）片段被删除", () => {
    assert.equal(stripReferenceMetadata("参考（用户图片114，7.jpg）中的车型。"), "参考中的车型。");
    assert.equal(stripReferenceMetadata("以（用户本轮图片237，CZ场景 1.png）为基准。"), "以为基准。");
});

test("普通文本与空值安全", () => {
    assert.equal(stripReferenceMetadata("图片1是唯一场景基准。"), "图片1是唯一场景基准。");
    assert.equal(stripReferenceMetadata(""), "");
});
