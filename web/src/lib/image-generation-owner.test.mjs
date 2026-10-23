import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function functionsFrom(path, names) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    return names.map((name) => {
        const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
        assert.ok(declaration, `真实服务函数 ${name} 必须存在`);
        return declaration.getText(ast).replace(/^export /, "");
    }).join("\n");
}

// Keep the public entry points, result synchronization and storage entry real.
// Only the upstream response and final persistence boundary are controlled.
const serviceFunctions = functionsFrom("../services/api/image.ts", [
    "captureImageRequestOwner", "isCurrentImageRequestOwner",
    "requestGeneration", "requestEdit", "syncGeneratedImages",
]);
const storageFunctions = functionsFrom("../services/image-storage.ts", ["autoSyncImage"]);
const realFunctions = ts.transpileModule(`${serviceFunctions}\n${storageFunctions}
globalThis.entryPoints = { requestGeneration, requestEdit };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness(initialOwner) {
    let owner = initialOwner;
    let resolveResponse;
    const response = new Promise((resolve) => { resolveResponse = resolve; });
    const writes = [];
    const sourceImage = {
        id: "original-owner-result", dataUrl: "data:image/png;base64,b2xkLXJlc3VsdA==",
        width: 1, height: 1, mimeType: "image/png",
    };
    const stored = { url: "stored-result.png", storageKey: "server:result", width: 1, height: 1, bytes: 10, mimeType: "image/png" };
    const scope = {
        Error,
        ImageRequestError: class extends Error {},
        useUserStore: { getState: () => ({ token: owner, user: owner ? { id: owner } : null }) },
        requestImages: () => response,
        refreshRemoteUser: () => {},
        generatedImageRequests: { run: (_key, upload) => upload() },
        getProxyUrl: (url) => url,
        fetch: async (url) => ({ ok: true, blob: async () => ({ sourceUrl: url }) }),
        persistGeneratedImageBlob: async (blob, _kind, _url, ownerToken) => {
            writes.push({ ownerToken, sourceUrl: blob.sourceUrl });
            return stored;
        },
        autoSyncToCloud: async (_key, upload) => upload(),
        uploadRemoteImageToServer: async (url) => {
            writes.push({ ownerToken: owner, sourceUrl: url });
            return stored;
        },
    };
    vm.createContext(scope);
    vm.runInContext(realFunctions, scope);
    return {
        writes, sourceImage, stored,
        switchOwner: (nextOwner) => { owner = nextOwner; },
        complete: () => resolveResponse([sourceImage]),
        start: (name) => {
            const options = { ownerToken: initialOwner, active: () => owner === initialOwner };
            const config = { channelMode: initialOwner ? "remote" : "local" };
            return name === "requestEdit"
                ? scope.entryPoints.requestEdit(config, "原身份的局部重绘", [{ id: "marked-reference" }], options)
                : scope.entryPoints.requestGeneration(config, "原身份的生成", options);
        },
    };
}

for (const entry of ["requestGeneration", "requestEdit"]) {
    for (const initialOwner of ["", "account-A"]) {
        test(`${entry}: ${initialOwner || "游客"} → B 的迟到结果不能以 B 同步存储`, async () => {
            const h = harness(initialOwner);
            const running = h.start(entry);
            h.switchOwner("account-B");
            h.complete();
            await Promise.allSettled([running]);
            assert.deepEqual(h.writes, [], "身份变化必须在真实 syncGeneratedImages/autoSyncImage 副作用前被拦截");
        });

        test(`${entry}: ${initialOwner || "游客"} 身份未变时仍正常同步结果`, async () => {
            const h = harness(initialOwner);
            const running = h.start(entry);
            h.complete();
            const images = await running;
            assert.deepEqual(h.writes, [{ ownerToken: initialOwner, sourceUrl: h.sourceImage.dataUrl }]);
            assert.equal(images[0].storageKey, h.stored.storageKey);
            assert.equal(images[0].dataUrl, h.stored.url);
        });
    }
}
