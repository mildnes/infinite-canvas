import assert from "node:assert/strict";
import test from "node:test";
import { imageOutputNoticeText } from "./image-output-notice.ts";

test("输出格式的未声明、无 alpha 和验证失败提示区分于格式回退", () => {
    assert.match(imageOutputNoticeText("undeclared"), /未声明输出格式能力/);
    assert.equal(imageOutputNoticeText("upstream-no-alpha"), "上游未返回透明通道");
    assert.match(imageOutputNoticeText("upstream-alpha-unverified"), /无法验证/);
    assert.match(imageOutputNoticeText("fallback-default"), /渠道能力回退/);
    assert.equal(imageOutputNoticeText(""), "");
});
