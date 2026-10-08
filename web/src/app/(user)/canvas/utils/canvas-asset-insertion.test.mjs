import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { stableAssetUrl } from "../../../../lib/asset-data.ts";

function fixture() {
    const calls = [], exports = {};
    const code = ts.transpileModule(readFileSync(new URL("./canvas-asset-insertion.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { exports, require: name => {
        if (name.endsWith("asset-data")) return { stableAssetUrl };
        return { resolveImageUrl: async (...args) => { calls.push(["image", ...args]); return args[0] ? "blob:cached" : args[1]; }, resolveMediaUrl: async (...args) => { calls.push(["media", ...args]); return args[0] ? "blob:cached" : args[1]; } };
    } });
    return { resolve: exports.resolveCanvasAssetPayload, calls };
}

test("insert resolution uses server keys for the four broken assets, video/audio, and is idempotent", async () => {
    const f = fixture();
    const objects = ["ee679235-4a63-47c2-92bc-3b81e1619cb8", "6ab7ffb8-2cfe-4b4b-a560-0897e9245f73", "b37f144f-6db9-4019-a6ba-53d3401be137", "2df18241-d791-4b67-ae6c-582d8a1ae86d"];
    for (const [index, id] of objects.entries()) {
        const input = { kind: "image", title: "broken", dataUrl: index < 2 ? "" : "blob:expired", storageKey: `server:${id}` };
        const result = await f.resolve(input);
        assert.equal(result.dataUrl, `/api/files/${id}/content`);
        assert.equal((await f.resolve(result)).dataUrl, result.dataUrl);
        assert.equal(input.dataUrl, index < 2 ? "" : "blob:expired");
    }
    for (const kind of ["video", "audio"]) assert.equal((await f.resolve({ kind, url: "blob:dead", storageKey: "server:media" })).url, "/api/files/media/content");
    assert.equal((await f.resolve({ kind: "image", dataUrl: "", storageKey: "image:local" })).dataUrl, "blob:cached");
    const text = { kind: "text", content: "unchanged" };
    assert.equal(await f.resolve(text), text);
    await assert.rejects(f.resolve({ kind: "image", dataUrl: "blob:dead" }), /重试插入/);
});

test("real insertAssetAt waits for resolution, creates readable nodes, and rejects stale account/project or missing media", async () => {
    const filename = new URL("../[id]/canvas-client-page.tsx", import.meta.url);
    // utils and [id] are sibling directories.
    const source = readFileSync(filename, "utf8"), ast = ts.createSourceFile("canvas.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let fn;
    function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "insertAssetAt") fn = node; ts.forEachChild(node, visit); }
    visit(ast);
    assert.ok(fn);
    const f = fixture(), user = { token: "owner" }, project = { current: "canvas" }, nodes = [], errors = [];
    let resolver = f.resolve;
    const code = ts.transpileModule(`globalThis.insert = ${fn.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    const context = { useUserStore: { getState: () => user }, projectId: "canvas", activeProjectIdRef: project, resolveCanvasAssetPayload: value => resolver(value), containerRef: { current: null }, size: { width: 100, height: 100 }, screenToCanvas: (x, y) => ({ x, y }), createNode: (...args) => nodes.push(args), setNodes: fn => { nodes.splice(0, nodes.length, ...fn(nodes)); }, setSelectedNodeIds: () => {}, setSelectedConnectionId: () => {}, fitNodeSize: () => ({ width: 10, height: 10 }), CanvasNodeType: { Text: "text", Video: "video", Audio: "audio" }, NODE_DEFAULT_SIZE: { video: { width: 10, height: 10 }, audio: { width: 10, height: 10 } }, VIDEO_NODE_MAX_WIDTH: 100, VIDEO_NODE_MAX_HEIGHT: 100, NODE_STATUS_SUCCESS: "success", insertAssistantImage: async payload => nodes.push({ metadata: { content: payload.dataUrl, storageKey: payload.storageKey } }), message: { error: value => errors.push(value) } };
    vm.createContext(context); vm.runInContext(code, context);
    for (const kind of ["image", "video", "audio"]) await context.insert({ kind, title: "file", dataUrl: "", url: "blob:dead", storageKey: "server:object" });
    assert.ok(nodes.every(node => node.metadata.content === "/api/files/object/content"));
    await context.insert({ kind: "image", dataUrl: "" });
    assert.equal(nodes.length, 3); assert.match(errors[0], /重试/);
    resolver = async value => { user.token = "other"; return f.resolve(value); };
    await context.insert({ kind: "image", dataUrl: "", storageKey: "server:late" });
    assert.equal(nodes.length, 3);
    user.token = "owner";
    resolver = async value => { project.current = "other"; return f.resolve(value); };
    await context.insert({ kind: "image", dataUrl: "", storageKey: "server:late" });
    assert.equal(nodes.length, 3);
});
