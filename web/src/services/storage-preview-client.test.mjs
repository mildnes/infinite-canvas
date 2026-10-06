import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const size = { width: 20080, height: 22450 };
const cachedResponse = () => ({ ok: true, blob: async () => new Blob(["original"], { type: "image/png" }) });

function fixture(upload = async () => {}, fetchImpl = async () => cachedResponse(), prepare = async blob => blob) {
    const state = { token: "owner" };
    const calls = [], fetches = [], decodes = [];
    const source = readFileSync(new URL("./storage-preview-client.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, AbortSignal, require: name => {
        if (name.endsWith("use-user-store")) return { useUserStore: { getState: () => state } };
        if (name.endsWith("api/storage")) return { uploadStoragePreview: async (...args) => { calls.push(args); await upload(); } };
        return { prepareImagePreview: (...args) => { decodes.push(args); return prepare(...args); } };
    }, fetch: (...args) => { fetches.push(args); return fetchImpl(...args); } });
    return { state, calls, fetches, decodes, publish: exports.publishStoragePreview, backfill: exports.backfillStoragePreviewFromOriginal };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test("preview cache upload deduplicates one object and ignores late previous-account decode", async () => {
    const f = fixture();
    const blob = new Blob(["jpeg"], { type: "image/jpeg" });
    f.publish("server:object", Promise.resolve(blob), "owner");
    f.publish("server:object", Promise.resolve(blob), "owner");
    await flush();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].slice(0, 3), ["owner", "object", blob]);
    let complete;
    f.publish("server:late", new Promise(resolve => { complete = resolve; }), "owner");
    f.state.token = "other";
    complete(blob);
    await flush();
    assert.equal(f.calls.length, 1);
});

test("preview failure preserves original operation and allows a later cache retry", async () => {
    const f = fixture(async () => { throw new Error("offline"); });
    const blob = new Blob(["jpeg"], { type: "image/jpeg" });
    f.publish("server:object", Promise.resolve(blob), "owner");
    await flush();
    f.publish("server:object", Promise.resolve(blob), "owner");
    await flush();
    f.publish("server:webdav:local", Promise.resolve(blob), "owner");
    f.publish("server:object", Promise.resolve(null), "owner");
    await flush();
    assert.equal(f.calls.length, 2);
});

test("backfill accepts only stable server keys, fails silently, and submits once per object", async () => {
    const f = fixture();
    for (const key of [undefined, "", "local:object", "server:webdav:path", "server:../object", "server:a/b", "server:a%2fb"]) f.backfill("/original", key, "owner", size);
    f.backfill("/original", "server:invalid-size", "owner", { width: 0, height: 10 });
    f.backfill("/original", "server:stale", "old-owner", size);
    f.backfill("", "server:empty-url", "owner", size);
    assert.equal(f.fetches.length, 0);
    f.backfill("/api/files/object/content", "server:object", "owner", size);
    f.backfill("/api/files/object/content", "server:object", "owner", size);
    await flush();
    assert.equal(f.fetches.length, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.fetches[0][1].cache, "only-if-cached");
    assert.equal(f.fetches[0][1].mode, "same-origin");
    assert.equal(f.decodes[0][1], size);
    f.state.token = "";
    f.backfill("/api/files/no-session/content", "server:no-session", "", size);
    assert.equal(f.fetches.length, 1);
});

test("cache miss, failed read, failed decode and rejected upload stay silent with no retry", async () => {
    const cases = [
        fixture(undefined, async () => { throw new Error("cache miss"); }),
        fixture(undefined, async () => ({ ok: false })),
        fixture(undefined, async () => ({ ok: true, blob: async () => { throw new Error("cache read failed"); } })),
        fixture(undefined, undefined, async () => null),
        fixture(undefined, undefined, async () => { throw new Error("decode failed"); }),
        fixture(async () => { throw new Error("403"); }),
    ];
    for (const f of cases) {
        assert.doesNotThrow(() => f.backfill("/original", "server:failed", "owner", size));
        await flush();
        f.backfill("/original", "server:failed", "owner", size);
        await flush();
        assert.equal(f.fetches.length, 1);
        assert.ok(f.calls.length <= 1);
    }
    const f = fixture();
    await assert.doesNotReject(f.publish("server:rejected", Promise.reject(new Error("decode failed")), "owner"));
    assert.equal(f.calls.length, 0);
});

test("account changes discard queued reads, late blobs and late decoded previews", async () => {
    let finishRead;
    const f = fixture(undefined, async () => ({ ok: true, blob: () => new Promise(resolve => { finishRead = resolve; }) }));
    f.backfill("/original", "server:late", "owner", size);
    await flush();
    f.state.token = "other";
    finishRead(new Blob(["png"], { type: "image/png" }));
    await flush();
    assert.equal(f.decodes.length, 0);
    assert.equal(f.calls.length, 0);

    let finishDecode;
    const g = fixture(undefined, undefined, () => new Promise(resolve => { finishDecode = resolve; }));
    g.backfill("/original", "server:decoded", "owner", size);
    await flush();
    g.state.token = "other";
    finishDecode(new Blob(["jpeg"], { type: "image/jpeg" }));
    await flush();
    assert.equal(g.calls.length, 0);
});

test("two whole backfill jobs include upload; queued old-account work never fetches", async () => {
    const releases = [];
    const f = fixture(() => new Promise(resolve => releases.push(resolve)));
    for (let i = 0; i < 4; i++) f.backfill("/original", `server:object-${i}`, "owner", size);
    await flush();
    assert.equal(f.fetches.length, 2);
    assert.equal(f.calls.length, 2);
    releases[0]();
    await flush();
    assert.equal(f.fetches.length, 3);
    assert.equal(f.calls.length, 3);
    f.state.token = "other";
    releases[1]();
    releases[2]();
    await flush();
    assert.equal(f.fetches.length, 3);
});
