import assert from "node:assert/strict";
import test from "node:test";
import { createImageOutputNoticeGate, imageOutputNoticeText, shouldNotifyImageOutputNotice } from "./image-output-notice.ts";

test("输出格式的未声明、无 alpha 和验证失败提示区分于格式回退", () => {
    assert.match(imageOutputNoticeText("undeclared"), /未声明输出格式能力/);
    assert.equal(imageOutputNoticeText("upstream-no-alpha"), "上游未返回透明通道");
    assert.match(imageOutputNoticeText("upstream-alpha-unverified"), /无法验证/);
    assert.match(imageOutputNoticeText("fallback-default"), /渠道能力回退/);
    assert.equal(imageOutputNoticeText(""), "");
});

test("「未声明输出格式能力」不再逐次弹提示，其余可操作提示保持", () => {
    assert.equal(shouldNotifyImageOutputNotice("undeclared"), false);
    assert.equal(shouldNotifyImageOutputNotice("fallback-default"), true);
    assert.equal(shouldNotifyImageOutputNotice("upstream-no-alpha"), true);
    assert.equal(shouldNotifyImageOutputNotice("upstream-alpha-unverified"), true);
    assert.equal(shouldNotifyImageOutputNotice(""), true);
});

test("同一渠道:模型组合每会话只提示一次（不依赖 2 秒窗口）", () => {
    const gate = createImageOutputNoticeGate();
    assert.equal(gate("channel-a:gemini-3-pro-image:undeclared"), true);
    assert.equal(gate("channel-a:gemini-3-pro-image:undeclared"), false);
    assert.equal(gate("channel-a:gpt-2.5-sunburst-4k:fallback-default"), true);
    assert.equal(gate("channel-b:gemini-3-pro-image:undeclared"), true);
});
