import assert from "node:assert/strict";
import test from "node:test";

import { StorageSyncDeduper } from "./storage-sync-deduper.ts";

test("相同稳定 ID 的并发与后续同步只执行一次", async () => {
    const deduper = new StorageSyncDeduper();
    let calls = 0;
    const execute = async () => ({ storageKey: `server:${++calls}` });
    const [first, second] = await Promise.all([deduper.run("result-1", execute, true), deduper.run("result-1", execute, true)]);
    const third = await deduper.run("result-1", execute, true);
    assert.equal(calls, 1);
    assert.equal(first, second);
    assert.equal(second, third);
});

test("失败结果与一次性 Blob 结果可以重新执行", async () => {
    const deduper = new StorageSyncDeduper();
    let calls = 0;
    await deduper.run("retry", async () => { calls += 1; return null; }, true);
    await deduper.run("retry", async () => { calls += 1; return { storageKey: "server:ok" }; }, false);
    await new Promise((resolve) => queueMicrotask(resolve));
    await deduper.run("retry", async () => { calls += 1; return { storageKey: "server:ok-2" }; }, false);
    assert.equal(calls, 3);
});
