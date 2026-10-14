import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function requestFixture(request) {
    const exports = {}, timers = new Map(); let sequence = 0;
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../services/api/request.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports, require: () => ({ default: { request } }), URLSearchParams, AbortController, setTimeout: (fn, ms) => { timers.set(++sequence, { fn, ms }); return sequence; }, clearTimeout: id => timers.delete(id) });
    return { ...exports, timers };
}

test("API blackhole requests have an AbortController and terminate within 15 seconds", async () => {
    let config;
    const f = requestFixture(value => { config = value; return new Promise((resolve, reject) => value.signal?.addEventListener("abort", () => reject(new Error("aborted")))); });
    const pending = f.apiGet("/blackhole");
    assert.ok(config.signal);
    assert.ok(config.timeout > 0 && config.timeout <= 15000);
    const timer = [...f.timers.values()][0]; assert.ok(timer.ms <= 15000); timer.fn();
    await assert.rejects(pending, /超时/);
    assert.equal(f.timers.size, 0);
});

test("API error retains HTTP status and conflict payload for recoverable canvas synchronization", async () => {
    const f = requestFixture(async () => ({ status: 409, data: { code: 1, msg: "conflict", data: { currentProject: { id: "p" } } } }));
    await assert.rejects(f.apiPost("/save"), error => error.status === 409 && error.data?.currentProject?.id === "p");
});
