import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./file-storage.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("file-storage.ts", source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "downloadRemoteMedia");
const code = ts.transpileModule("(" + declaration.getText(ast).replace(/^export\s+/, "") + ")", { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;

function fixture(type) {
    const calls = [];
    const blob = new Blob(["media-bytes"], { type });
    const download = vm.runInNewContext(code, {
        getProxyUrl: (url) => url.startsWith("https://") ? `/api/proxy-image?url=${encodeURIComponent(url)}` : url,
        fetch: async (url) => { calls.push(url); return { ok: true, blob: async () => blob }; },
        Error,
    });
    return { calls, blob, download };
}

for (const type of ["video/mp4", "audio/wav", "image/png"]) {
    test(`remote ${type} downloads use the media MIME policy`, async () => {
        const f = fixture(type);
        const url = "https://cdn.example/result";
        assert.equal(await f.download(url), f.blob);
        assert.equal(f.calls[0], `/api/proxy-media?url=${encodeURIComponent(url)}`);
    });
}

test("stable content and local media URLs remain direct", async () => {
    const f = fixture("video/mp4");
    for (const url of ["/api/files/object/content", "blob:local-media", "data:audio/wav;base64,AAAA"]) {
        assert.equal(await f.download(url), f.blob);
        assert.equal(f.calls.at(-1), url);
    }
});

test("legacy image-proxy media links use the safe media endpoint", async () => {
    const f = fixture("video/mp4");
    await f.download("/api/proxy-image?url=https%3A%2F%2Fcdn.example%2Fresult.mp4");
    assert.equal(f.calls[0], "/api/proxy-media?url=https%3A%2F%2Fcdn.example%2Fresult.mp4");
});
