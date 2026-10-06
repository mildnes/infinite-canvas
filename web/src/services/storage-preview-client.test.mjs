import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function fixture(upload = async () => {}) {
    const state = { token: "owner" };
    const calls = [];
    const source = readFileSync(new URL("./storage-preview-client.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, AbortSignal, require: name => {
        if (name.endsWith("use-user-store")) return { useUserStore: { getState: () => state } };
        if (name.endsWith("api/storage")) return { uploadStoragePreview: async (...args) => { calls.push(args); await upload(); } };
        return { prepareImagePreview() {} };
    } });
    return { state, calls, publish: exports.publishStoragePreview };
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
