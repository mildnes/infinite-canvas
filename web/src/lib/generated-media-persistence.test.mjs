import assert from "node:assert/strict";
import test from "node:test";

import { assertGeneratedMediaOwner, isStableGeneratedMediaKey } from "./generated-media-persistence.ts";

test("只有 server 引用表示生成媒体已获得跨浏览器稳定副本", () => {
    assert.equal(isStableGeneratedMediaKey("server:object-id"), true);
    assert.equal(isStableGeneratedMediaKey("image:local-id"), false);
    assert.equal(isStableGeneratedMediaKey(""), false);
});

test("账号切换后拒绝迟到的持久化结果", () => {
    assert.doesNotThrow(() => assertGeneratedMediaOwner("token-a", "token-a"));
    assert.throws(() => assertGeneratedMediaOwner("token-b", "token-a"), /账号已切换/);
});
