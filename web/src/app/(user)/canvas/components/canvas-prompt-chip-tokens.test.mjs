import assert from "node:assert/strict";
import test from "node:test";

import { parsePromptTokens } from "./canvas-prompt-chip-tokens.ts";

test("标签后紧邻数字时不匹配更长编号（图片221 不拆成 图片2+21）", () => {
    const tokens = parsePromptTokens("（用户本轮图片221）", ["图片1", "图片2"]);
    assert.deepEqual(tokens, [{ type: "text", value: "（用户本轮图片221）" }]);
});

test("标签后紧邻数字时不匹配更长编号（图片176 不拆成 图片1+76）", () => {
    const tokens = parsePromptTokens("图片2（用户本轮图片176）是权威来源", ["图片1", "图片2"]);
    assert.deepEqual(tokens, [
        { type: "reference", label: "图片2" },
        { type: "text", value: "（用户本轮图片176）是权威来源" },
    ]);
});

test("正常引用的标签照常匹配（含中文标点与括号边界）", () => {
    const tokens = parsePromptTokens("仅局部编辑图片1（用户本轮图片221）。图片1是唯一场景。", ["图片1", "图片2"]);
    assert.deepEqual(tokens, [
        { type: "text", value: "仅局部编辑" },
        { type: "reference", label: "图片1" },
        { type: "text", value: "（用户本轮图片221）。" },
        { type: "reference", label: "图片1" },
        { type: "text", value: "是唯一场景。" },
    ]);
});

test("相邻标签与 @ 前缀保持原行为", () => {
    assert.deepEqual(parsePromptTokens("图片1图片2", ["图片1", "图片2"]), [
        { type: "reference", label: "图片1" },
        { type: "reference", label: "图片2" },
    ]);
    assert.deepEqual(parsePromptTokens("@图片1 请替换", ["图片1"]), [
        { type: "reference", label: "@图片1" },
        { type: "text", value: " 请替换" },
    ]);
});

test("只声明图片1时，图片10/图片176 等更长编号不误伤", () => {
    assert.deepEqual(parsePromptTokens("参考图片10和图片1", ["图片1"]), [
        { type: "text", value: "参考图片10和" },
        { type: "reference", label: "图片1" },
    ]);
});

test("无标签或无匹配时返回纯文本", () => {
    assert.deepEqual(parsePromptTokens("没有引用", []), [{ type: "text", value: "没有引用" }]);
    assert.deepEqual(parsePromptTokens("", ["图片1"]), []);
    assert.deepEqual(parsePromptTokens("没有引用", ["图片1"]), [{ type: "text", value: "没有引用" }]);
});
