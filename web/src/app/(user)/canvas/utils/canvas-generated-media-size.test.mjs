import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import test from "node:test";
import {
    IMAGE_NODE_DEFAULT_SIZE,
    VIDEO_NODE_DEFAULT_SIZE,
    applyGeneratedMediaSize,
    centerResizedNodeSize,
    isGeneratedMediaNode,
    resolveGeneratedMediaSize,
} from "./canvas-generated-media-size.ts";

const nodeSource = readFileSync(new URL("../components/canvas-node.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const constantsSource = readFileSync(new URL("../constants.ts", import.meta.url), "utf8");

function extractFunction(source, name) {
    const ast = ts.createSourceFile(`${name}.tsx`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const nodes = [];
    const walk = (node) => {
        nodes.push(node);
        ts.forEachChild(node, walk);
    };
    walk(ast);
    const definition = nodes.find((node) =>
        (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
        (node.name?.text === name || node.name?.getText(ast) === name)
    );
    assert.ok(definition, `${name} must exist`);
    return ts.transpileModule(definition.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
}

test("generated landscape image follows its real 16:9 ratio without changing the center", () => {
    const node = { type: "image", width: 420, height: 236, position: { x: 100, y: 200 }, metadata: { imageTaskId: "client_image_task_1" } };
    const size = resolveGeneratedMediaSize(node, 3840, 2160);
    assert.ok(size, "generated image must produce a size");
    assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.001);
    const placed = centerResizedNodeSize(node, size);
    assert.deepEqual({ x: placed.position.x + placed.width / 2, y: placed.position.y + placed.height / 2 }, { x: 310, y: 318 });
});

test("generated portrait video follows the real media ratio", () => {
    const size = resolveGeneratedMediaSize({ type: "video", width: 420, height: 236, metadata: { videoTaskId: "client_video_task_1" } }, 720, 1280);
    assert.ok(size, "generated video must produce a size");
    assert.ok(size.height > size.width, "portrait media must produce a portrait node");
    assert.ok(Math.abs(size.width / size.height - 720 / 1280) < 0.001);
});

test("manual and batch media never auto-resize", () => {
    assert.equal(resolveGeneratedMediaSize({ type: "image", width: 420, height: 236, metadata: {} }, 3840, 2160), null);
    assert.equal(isGeneratedMediaNode({ type: "panorama", metadata: { imageTaskId: "task" } }), false);
    assert.equal(isGeneratedMediaNode({ type: "image", metadata: { imageTaskId: "task", isBatchRoot: true } }), false);
    assert.equal(isGeneratedMediaNode({ type: "image", metadata: { imageTaskId: "task", batchRootId: "root" } }), false);
    assert.equal(isGeneratedMediaNode({ type: "image", metadata: { imageTaskId: "task", freeResize: true } }), false);
});

test("real media callbacks are guarded by currentSrc and preserve video duration", () => {
    const onMediaLoaded = (node, width, height) => ({ node, width, height });
    let loaded;
    const image = { currentSrc: "/media", src: "/media", naturalWidth: 3840, naturalHeight: 2160 };
    if (image.currentSrc === image.src) loaded = onMediaLoaded({ id: "image" }, image.naturalWidth, image.naturalHeight);
    assert.deepEqual(loaded, { node: { id: "image" }, width: 3840, height: 2160 });

    image.currentSrc = "/old-media";
    loaded = undefined;
    if (image.currentSrc === image.src) loaded = onMediaLoaded({ id: "image" }, image.naturalWidth, image.naturalHeight);
    assert.equal(loaded, undefined);

    const video = { currentSrc: "/video", src: "/video", videoWidth: 720, videoHeight: 1280, duration: 8 };
    let mediaDurationMs = 0;
    let videoLoaded;
    mediaDurationMs = Number.isFinite(video.duration) ? video.duration * 1000 : 0;
    if (video.currentSrc === video.src) videoLoaded = onMediaLoaded({ id: "video" }, video.videoWidth, video.videoHeight);
    assert.equal(mediaDurationMs, 8000);
    assert.deepEqual(videoLoaded, { node: { id: "video" }, width: 720, height: 1280 });
    extractFunction(nodeSource, "VideoNodeContent");
    assert.ok(/onMediaLoaded\?\.\(node, video\.videoWidth, video\.videoHeight\)/.test(nodeSource));
});

test("page consumes loaded media identity and skips auto-sizing once the user resized the node", () => {
    const handler = extractFunction(pageSource, "handleNodeResize");
    assert.ok(/loadedNode/.test(handler), handler);
    assert.ok(/applyGeneratedMediaSize\(node, width, height\)/.test(handler), handler);
    assert.match(handler, /position\s*\|\|\s*node\.position/);
    assert.match(handler, /freeResize:\s*true/);
});

test("auto-sizing records the real natural dimensions for later manual resize", () => {
    const node = { type: "image", width: 420, height: 236, position: { x: 100, y: 200 }, metadata: { imageTaskId: "client_image_task_1", prompt: "keep" } };
    const patch = applyGeneratedMediaSize(node, 3840, 2160);
    assert.ok(patch);
    assert.equal(patch.metadata.prompt, "keep");
    assert.equal(patch.metadata.naturalWidth, 3840);
    assert.equal(patch.metadata.naturalHeight, 2160);
    assert.ok(Math.abs(patch.width / patch.height - 16 / 9) < 0.001);
    assert.equal(applyGeneratedMediaSize({ ...node, metadata: { ...node.metadata, freeResize: true } }, 3840, 2160), null);
});

test("generated image and video nodes use the shared 420x236 default while local uploads may use natural size", () => {
    assert.deepEqual(IMAGE_NODE_DEFAULT_SIZE, { width: 420, height: 236 });
    assert.deepEqual(VIDEO_NODE_DEFAULT_SIZE, { width: 420, height: 236 });
    assert.ok(/\[CanvasNodeType\.Image\]: \{ width: 420, height: 236/.test(constantsSource));
});

test("manual resize marks the node so later media load cannot override it", () => {
    const handler = extractFunction(nodeSource, "handleResizeUp");
    assert.match(handler, /isResizing\)\s*return/);
    assert.match(handler, /currentWidth/);
    assert.match(handler, /currentHeight/);
    assert.match(handler, /freeResize:\s*true/);
});
