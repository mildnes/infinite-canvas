import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { CanvasNodeType } from "../types.ts";
import { buildNodeGenerationContext } from "../components/canvas-node-generation.ts";
import { copiedCanvasNodeMetadata } from "./canvas-node-copy.ts";
import { mergeCanvasMediaRepair, nodeNeedsCloudUpload } from "./canvas-media-persistence.ts";

const source = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("canvas.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function walk(node) {
    if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) declarations.set(node.name?.getText(ast), node);
    ts.forEachChild(node, walk);
}
walk(ast);
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
function loadCallback(name, scope) {
    const callback = declarations.get(name).initializer.arguments[0].getText(ast);
    return vm.runInNewContext(compile(`(${callback})`), scope);
}
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
};
const media = (id = "image") => ({
    id, type: CanvasNodeType.Image, title: "original title", position: { x: 10, y: 20 }, width: 320, height: 180,
    metadata: {
        content: "blob:original", storageKey: "image:original", originalUrl: "blob:original", mediaStatus: "local-only",
        mediaError: "local only", mimeType: "image/png", bytes: 10, naturalWidth: 640, naturalHeight: 360, durationMs: 1000,
        prompt: "original prompt", groupId: "original group",
    },
});
function uploaded(node) {
    return {
        node: {
            ...node,
            metadata: {
                ...node.metadata, content: "/api/files/uploaded/content", storageKey: "server:uploaded",
                originalUrl: "https://example.com/uploaded.png", mediaStatus: "ok", mediaError: undefined,
                mimeType: "image/webp", bytes: 20, naturalWidth: 1280, naturalHeight: 720, durationMs: 2000,
            },
        },
        uploaded: true,
    };
}

function uploadHarness(nodes = [media()]) {
    const started = deferred();
    const completion = deferred();
    const notices = [];
    const calls = [];
    let loadingClosed = 0;
    const h = {
        nodesRef: { current: nodes }, activeProjectIdRef: { current: "project" }, projectId: "project",
        token: "owner", writable: true, configured: true, message: {},
        requireCanvasWriter: () => h.writable,
        canUploadCanvasMediaToServer: async () => h.configured,
        useUserStore: { getState: () => ({ token: h.token }) },
        nodeNeedsCloudUpload, mergeCanvasMediaRepair,
        uploadCanvasNodeToCloud: async node => { calls.push(node); started.resolve(); return completion.promise; },
        setNodes: update => { h.nodesRef.current = typeof update === "function" ? update(h.nodesRef.current) : update; },
    };
    for (const level of ["info", "error", "warning", "success"]) h.message[level] = text => notices.push({ level, text });
    h.message.loading = () => () => { loadingClosed += 1; };
    h.run = loadCallback("uploadBoardMediaToCloud", h);
    return { h, started, completion, notices, calls, get loadingClosed() { return loadingClosed; } };
}

test("delayed board upload updates media fields while preserving live layout, title, prompt and group", async () => {
    const fixture = uploadHarness();
    const { h, started, completion } = fixture;
    const original = h.nodesRef.current[0];
    const pending = h.run();
    await started.promise;
    h.setNodes(current => current.map(node => ({
        ...node, title: "edited title", position: { x: 999, y: 888 }, width: 500, height: 400,
        metadata: { ...node.metadata, prompt: "edited prompt", groupId: "edited group", freeResize: true },
    })));
    completion.resolve(uploaded(original));
    await pending;
    const actual = h.nodesRef.current[0];
    assert.deepEqual(
        { title: actual.title, position: actual.position, width: actual.width, height: actual.height, prompt: actual.metadata.prompt, group: actual.metadata.groupId, freeResize: actual.metadata.freeResize },
        { title: "edited title", position: { x: 999, y: 888 }, width: 500, height: 400, prompt: "edited prompt", group: "edited group", freeResize: true },
        "upload completion must retain edits made while the network request is pending",
    );
    for (const key of ["content", "storageKey", "originalUrl", "mediaStatus", "mediaError", "mimeType", "bytes", "naturalWidth", "naturalHeight", "durationMs"]) {
        assert.equal(actual.metadata[key], uploaded(original).node.metadata[key], key);
    }
    assert.equal(original.metadata.storageKey, "image:original");
    assert.equal(fixture.loadingClosed, 1);
    assert.match(fixture.notices.at(-1).text, /已上传 1 个媒体/);
});

test("delayed board upload keeps replacement media and does not resurrect deleted nodes", async () => {
    const fixture = uploadHarness();
    const { h, started, completion } = fixture;
    const original = h.nodesRef.current[0];
    const pending = h.run();
    await started.promise;
    const replacement = { ...original, metadata: { ...original.metadata, content: "blob:replacement", storageKey: "image:replacement" } };
    h.setNodes([replacement]);
    completion.resolve(uploaded(original));
    await pending;
    assert.equal(h.nodesRef.current[0].metadata.content, "blob:replacement", "late upload must not replace a newly chosen image");
    assert.equal(h.nodesRef.current[0].metadata.storageKey, "image:replacement");
    assert.equal(h.nodesRef.current[0].metadata.mediaStatus, "local-only");

    const removed = uploadHarness();
    const deleting = removed.h.run();
    await removed.started.promise;
    removed.h.setNodes([]);
    removed.completion.resolve(uploaded(original));
    await deleting;
    assert.equal(removed.h.nodesRef.current.length, 0);
});

test("board upload keeps owner/project guards, write checks and failure feedback", async () => {
    for (const invalidate of [
        h => { h.token = "other owner"; },
        h => { h.activeProjectIdRef.current = "other project"; },
    ]) {
        const fixture = uploadHarness();
        const pending = fixture.h.run();
        await fixture.started.promise;
        invalidate(fixture.h);
        fixture.completion.resolve(uploaded(fixture.h.nodesRef.current[0]));
        await pending;
        assert.equal(fixture.h.nodesRef.current[0].metadata.storageKey, "image:original");
        assert.equal(fixture.notices.length, 0);
        assert.equal(fixture.loadingClosed, 1);
    }
    const readOnly = uploadHarness();
    readOnly.h.writable = false;
    await readOnly.h.run();
    assert.equal(readOnly.calls.length, 0);

    const failed = uploadHarness();
    const failing = failed.h.run();
    await failed.started.promise;
    failed.completion.reject(new Error("upload failed"));
    await failing;
    assert.equal(failed.notices.at(-1).level, "warning");
    assert.match(failed.notices.at(-1).text, /1 个媒体上传失败/);
    assert.equal(failed.loadingClosed, 1);
});

const resource = (id, type, content = id) => ({
    id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100,
    metadata: { content, storageKey: `server:${id}` },
});
function copyHarness(nodes, connections) {
    let random = 0;
    const h = {
        nodesRef: { current: nodes }, connectionsRef: { current: connections }, selectedNodeIdsRef: { current: new Set(nodes.map(node => node.id)) },
        clipboardRef: { current: null }, requireCanvasWriter: () => true, CanvasNodeType, copiedCanvasNodeMetadata,
        Date: { now: () => 1000 }, Math: Object.assign(Object.create(Math), { random: () => ++random / 100 }),
        getCanvasCenter: () => ({ x: 500, y: 500 }),
        setNodes: update => { h.nodesRef.current = typeof update === "function" ? update(h.nodesRef.current) : update; },
        setConnections: update => { h.connectionsRef.current = typeof update === "function" ? update(h.connectionsRef.current) : update; },
        setSelectedNodeIds: ids => { h.selectedNodeIdsRef.current = ids; },
        setSelectedConnectionId() {}, setContextMenu() {}, setDialogNodeId() {},
        isMimoVoiceCloneModel: model => model === "mimo-v2.5-tts-voice-clone",
    };
    for (const name of ["copySelectedNodes", "pasteCopiedNodes", "duplicateNode"]) h[name] = loadCallback(name, h);
    h.selectAudioReference = vm.runInNewContext(compile(`(${declarations.get("selectAudioReference").getText(ast)})`), h);
    return h;
}

test("real copy/paste remaps composer tokens so generation reads the copied text and images", () => {
    const text = resource("text", CanvasNodeType.Text, "copied instructions");
    const image = resource("image", CanvasNodeType.Image, "blob:copied-image");
    const config = resource("config", CanvasNodeType.Config);
    config.metadata = { composerContent: "Use @[node:text] and @[node:image]. Keep @[node:external].", firstFrameNodeId: "image" };
    const originals = [text, image, config];
    const snapshot = JSON.stringify(originals);
    const h = copyHarness(originals, [text, image].map(node => ({ id: `edge-${node.id}`, fromNodeId: node.id, toNodeId: config.id })));
    h.copySelectedNodes();
    assert.equal(h.pasteCopiedNodes(), true);
    const [newText, newImage, newConfig] = h.nodesRef.current.slice(originals.length);
    const context = buildNodeGenerationContext(newConfig.id, h.nodesRef.current, h.connectionsRef.current, newConfig.metadata.composerContent);
    assert.match(context.prompt, /copied instructions/, "pasted composer must resolve its text token against the pasted connection");
    assert.equal(context.firstFrame?.id, newImage.id);
    assert.equal(newConfig.metadata.composerContent, `Use @[node:${newText.id}] and @[node:${newImage.id}]. Keep @[node:external].`);
    assert.equal(JSON.stringify(originals), snapshot);
});

test("copy/paste remaps only declared node references including nested Kling fields, leaving sources and opaque values intact", () => {
    const ids = ["first", "last", "audio", "other-audio", "shot", "kling", "element-video"];
    const types = [CanvasNodeType.Image, CanvasNodeType.Image, CanvasNodeType.Audio, CanvasNodeType.Audio, CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video];
    const resources = ids.map((id, index) => resource(id, types[index]));
    const config = resource("config", CanvasNodeType.Config);
    config.metadata = {
        composerContent: "first @[node:first] audio @[node:audio] @[node:other-audio] plain first",
        firstFrameNodeId: "first", lastFrameNodeId: "last", referenceAudioNodeId: "audio", mimoVoiceCloneAudioNodeId: "audio",
        klingImageNodeIds: ["kling", "external-image"],
        klingMultiPrompt: [{ textNodeId: "shot", duration: "5" }, { textNodeId: "external-shot", duration: "first" }],
        klingElementList: [{ name: "first", description: "audio", nodeIds: ["element-video", "external-element"] }],
        prompt: "literal @[node:first]", content: "https://example.com/first", storageKey: "server:first",
        references: ["first", "server:first", "https://example.com/first"], originalUrl: "https://example.com/first",
        directorProject: { arbitraryNodeId: "first", arbitraryText: "@[node:audio]" },
    };
    const originals = [...resources, config];
    const snapshot = JSON.stringify(originals);
    const h = copyHarness(originals, resources.map(node => ({ id: `edge-${node.id}`, fromNodeId: node.id, toNodeId: config.id })));
    h.copySelectedNodes();
    h.pasteCopiedNodes();
    const copies = h.nodesRef.current.slice(originals.length);
    const mapped = new Map(originals.map((node, index) => [node.id, copies[index].id]));
    const metadata = copies.at(-1).metadata;
    for (const [field, id] of [
        ["firstFrameNodeId", "first"], ["lastFrameNodeId", "last"], ["referenceAudioNodeId", "audio"], ["mimoVoiceCloneAudioNodeId", "audio"],
    ]) assert.equal(metadata[field], mapped.get(id), field);
    assert.deepEqual(metadata.klingImageNodeIds, [mapped.get("kling"), "external-image"]);
    assert.deepEqual(metadata.klingMultiPrompt, [{ textNodeId: mapped.get("shot"), duration: "5" }, { textNodeId: "external-shot", duration: "first" }]);
    assert.deepEqual(metadata.klingElementList, [{ name: "first", description: "audio", nodeIds: [mapped.get("element-video"), "external-element"] }]);
    for (const key of ["prompt", "content", "storageKey", "references", "originalUrl", "directorProject"]) assert.deepEqual(metadata[key], config.metadata[key], key);
    const context = buildNodeGenerationContext(copies.at(-1).id, h.nodesRef.current, h.connectionsRef.current, metadata.composerContent);
    assert.equal(context.firstFrame?.id, mapped.get("first"));
    assert.equal(context.lastFrame?.id, mapped.get("last"));
    assert.deepEqual(context.referenceImages.map(item => item.id), [mapped.get("kling")]);
    assert.deepEqual(context.videoMultiPrompt, [{ prompt: "shot", duration: "5" }]);
    assert.deepEqual(context.videoElementList[0].references.map(item => item.id), [mapped.get("element-video")]);
    assert.equal(h.selectAudioReference({ model: "mimo-v2.5-tts-voice-clone" }, metadata, context.referenceAudios).id, mapped.get("audio"));
    assert.equal(JSON.stringify(originals), snapshot);
    assert.notEqual(metadata.klingImageNodeIds, config.metadata.klingImageNodeIds);
    assert.notEqual(metadata.klingMultiPrompt[0], config.metadata.klingMultiPrompt[0]);
    assert.notEqual(metadata.klingElementList[0], config.metadata.klingElementList[0]);
    assert.notEqual(metadata.klingElementList[0].nodeIds, config.metadata.klingElementList[0].nodeIds);
});

test("single-node duplicate remaps self references while retaining external references", () => {
    const original = resource("self", CanvasNodeType.Config);
    original.metadata = { composerContent: "@[node:self] @[node:external] literal self", firstFrameNodeId: "external", klingMultiPrompt: [{ textNodeId: "self", duration: "self" }] };
    const h = copyHarness([original], []);
    h.duplicateNode(original.id);
    const copy = h.nodesRef.current.at(-1);
    assert.equal(copy.metadata.composerContent, `@[node:${copy.id}] @[node:external] literal self`);
    assert.equal(copy.metadata.firstFrameNodeId, "external");
    assert.equal(copy.metadata.klingMultiPrompt[0].textNodeId, copy.id);
    assert.equal(copy.metadata.klingMultiPrompt[0].duration, "self");
    assert.equal(original.metadata.klingMultiPrompt[0].textNodeId, "self");
});
