import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./image-storage.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("storage.ts", source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "uploadRemoteImageToServer");
const code = ts.transpileModule("(" + declaration.getText(ast).replace(/^export\s+/, "") + ")", { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;

function fixture(token, userProvider = { type: "s3" }) {
    const blob = new Blob(["image"], { type: "image/png" });
    const image = { url: "/api/files/object/content", storageKey: "server:object" };
    const calls = [];
    const upload = vm.runInNewContext(code, {
        useUserStore: { getState: () => ({ token }) },
        getProxyUrl: (url) => "/proxy?url=" + encodeURIComponent(url),
        fetch: async (url) => { calls.push(["fetch", url]); return { ok: true, blob: async () => blob }; },
        loadStorageConfig: async () => { calls.push(["config"]); return { allowUserProvider: true }; },
        loadUserStorageProvider: () => userProvider,
        canUseGlobalStorage: () => true,
        uploadAnonymousStorageFile: async (...args) => { calls.push(["anonymous", ...args]); return image; },
        cacheAnonymousImage: (uploaded, input) => { calls.push(["cache", uploaded, input]); return uploaded; },
        toProviderPayload: (provider) => provider,
        persistGeneratedImageBlob: async (...args) => { calls.push(["generated", ...args]); return image; },
        Blob,
        Error,
    });
    return { upload, calls, blob, image, userProvider };
}

test("游客远程图片使用匿名上传，不引用未定义 token", async () => {
    const f = fixture("");
    assert.equal(await f.upload("https://images.example/a.png", "asset.png"), f.image);
    assert.deepEqual(f.calls, [
        ["fetch", "/proxy?url=https%3A%2F%2Fimages.example%2Fa.png"],
        ["config"],
        ["anonymous", f.blob, "asset.png", f.userProvider],
        ["cache", f.image, f.blob],
    ]);
});

test("游客没有自建存储时返回登录提示，不抛 ReferenceError", async () => {
    const f = fixture("", null);
    await assert.rejects(f.upload("https://images.example/a.png", "asset.png"), /服务端存储需要先登录/);
    assert.deepEqual(f.calls.map(([kind]) => kind), ["fetch", "config"]);
});

test("登录后仍提前走生成媒体持久化，保留原 ownerToken 与来源", async () => {
    const f = fixture("owner-token");
    assert.equal(await f.upload("https://images.example/a.png", "generated.png"), f.image);
    assert.deepEqual(f.calls, [
        ["fetch", "/proxy?url=https%3A%2F%2Fimages.example%2Fa.png"],
        ["generated", f.blob, "generated.png", "https://images.example/a.png", "owner-token"],
    ]);
});
