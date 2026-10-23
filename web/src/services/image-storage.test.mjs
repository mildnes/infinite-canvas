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

function realFunctions(path, names) {
    const text = readFileSync(new URL(path, import.meta.url), "utf8");
    const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    return ts.transpileModule(names.map((name) => tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(tree).replace(/^export\s+/, "")).join("\n"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
}

const syncCode = realFunctions("./image-storage.ts", ["autoSyncImage", "autoSyncToCloud", "autoSyncIdentity"]);
const retryCode = realFunctions("./api/image.ts", ["requestWithTransientRetry", "retryDelay", "isTransientStatus"]);

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

test("匿名结果等待自动同步配置期间登录，不发起任何上传", async () => {
    let token = "";
    let writes = 0;
    const config = deferred();
    const scope = {
        useUserStore: { getState: () => ({ token }) },
        loadStorageConfig: () => config.promise,
        uploadRemoteImageToServer: () => { writes += 1; },
    };
    vm.createContext(scope);
    vm.runInContext(syncCode, scope);
    const pending = scope.autoSyncImage("data:image/png;base64,aA==", "old-result", undefined, { ownerToken: "" });
    token = "account-B";
    config.resolve({ autoSyncAllAssets: true });
    await assert.rejects(pending, /登录状态已变化/);
    assert.equal(writes, 0);
});

test("登录结果等待图片下载期间切号，不持久化迟到图片", async () => {
    let token = "account-A";
    let writes = 0;
    const blob = deferred();
    const scope = {
        useUserStore: { getState: () => ({ token }) },
        generatedImageRequests: { run: (_key, execute) => execute() },
        getProxyUrl: (url) => url,
        fetch: async () => ({ ok: true, blob: () => blob.promise }),
        persistGeneratedImageBlob: () => { writes += 1; },
    };
    vm.createContext(scope);
    vm.runInContext(syncCode, scope);
    const pending = scope.autoSyncImage("image.png", "old-result", undefined, { ownerToken: "account-A" });
    token = "account-B";
    blob.resolve(new Blob(["image"]));
    await assert.rejects(pending, /登录状态已变化/);
    assert.equal(writes, 0);
});

test("匿名同步显式传递捕获的空 token，身份未变时仍上传", async () => {
    const captured = [];
    const stored = { storageKey: "server:anonymous", url: "stored.png" };
    const scope = {
        useUserStore: { getState: () => ({ token: "" }) },
        autoSyncToCloud: (_key, execute) => execute(),
        uploadRemoteImageToServer: async (...args) => { captured.push(args); return stored; },
    };
    vm.createContext(scope);
    vm.runInContext(realFunctions("./image-storage.ts", ["autoSyncImage"]), scope);
    assert.equal(await scope.autoSyncImage("image.png", "old-result", undefined, { ownerToken: "" }), stored);
    assert.deepEqual(captured, [["image.png", "image", ""]]);
});

for (const switched of [false, true]) {
    test(`请求等待重试期间${switched ? "切号后停止后续请求" : "身份未变则保留重试"}`, async () => {
        let token = "account-A";
        let attempts = 0;
        const waiting = deferred();
        const resume = deferred();
        const scope = {
            useUserStore: { getState: () => ({ token }) },
            window: { setTimeout: (done) => { waiting.resolve(); void resume.promise.then(done); } },
        };
        vm.createContext(scope);
        vm.runInContext(retryCode, scope);
        const pending = scope.requestWithTransientRetry(async () => ({ status: ++attempts === 1 ? 503 : 200 }), 2, { ownerToken: "account-A" });
        await waiting.promise;
        if (switched) token = "account-B";
        resume.resolve();
        if (switched) await assert.rejects(pending, /登录状态已变化/);
        else assert.equal((await pending).status, 200);
        assert.equal(attempts, switched ? 1 : 2);
    });
}
