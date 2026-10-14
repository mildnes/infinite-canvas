import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./file-storage.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("file-storage.ts", source, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && ["uploadMediaBlob", "uploadMediaBlobToServer"].includes(node.name?.text));
const code = ts.transpileModule(functions.map((node) => node.getText(ast).replace(/^export\s+/, "")).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;

test("guest import rejects a changed owner before uploading media", async () => {
    const calls = [];
    const context = vm.createContext({
        useUserStore: { getState: () => ({ token: "different-owner" }) },
        assertGeneratedMediaOwner: (current, owner) => { if (current !== owner) throw new Error("账号已切换"); },
        prepareImagePreview: () => null,
        loadStorageConfig: async () => ({ allowUserProvider: false }),
        canUseGlobalStorage: () => true,
        fetch: async (...args) => { calls.push(args); return { ok: true, json: async () => ({ code: 0, data: { storageKey: "server:object", url: "/api/files/object/content" } }) }; },
        publishStoragePreview: () => {},
        FormData, Blob, Error,
    });
    vm.runInContext(code, context);
    await assert.rejects(context.uploadMediaBlob(new Blob(["audio"], { type: "audio/wav" }), "reference.wav", "original-owner"), /账号已切换/);
    assert.equal(calls.length, 0);
});

test("guest import discards a media upload result arriving after an account switch", async () => {
    let token = "original-owner";
    const context = vm.createContext({
        useUserStore: { getState: () => ({ token }) },
        assertGeneratedMediaOwner: (current, owner) => { if (current !== owner) throw new Error("账号已切换"); },
        prepareImagePreview: () => null,
        loadStorageConfig: async () => ({ allowUserProvider: false }),
        canUseGlobalStorage: () => true,
        fetch: async () => {
            token = "new-owner";
            return { ok: true, json: async () => ({ code: 0, data: { storageKey: "server:object", url: "/api/files/object/content" } }) };
        },
        publishStoragePreview: () => { throw new Error("late upload must not be published"); },
        FormData, Blob, Error,
    });
    vm.runInContext(code, context);
    await assert.rejects(context.uploadMediaBlob(new Blob(["audio"], { type: "audio/wav" }), "reference.wav", "original-owner"), /账号已切换/);
});
