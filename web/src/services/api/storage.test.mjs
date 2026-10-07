import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

test("preview PUT sends the encoded Blob MIME, bytes, owner and abort signal", async () => {
    const source = readFileSync(new URL("./storage.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {}, calls = [];
    vm.runInNewContext(code, { exports, require: () => ({}), fetch: async (...args) => { calls.push(args); return { ok: true }; } });
    const signal = new AbortController().signal;
    for (const type of ["image/png", "image/jpeg"]) {
        const blob = new Blob(["encoded preview"], { type });
        await exports.uploadStoragePreview("owner", "object", blob, signal);
        const [url, request] = calls.at(-1);
        assert.equal(url, "/api/v1/files/object/preview");
        assert.equal(request.headers["Content-Type"], type);
        assert.equal(request.headers.Authorization, "Bearer owner");
        assert.equal(request.method, "PUT");
        assert.equal(request.body, blob);
        assert.equal(request.signal, signal);
    }
});
