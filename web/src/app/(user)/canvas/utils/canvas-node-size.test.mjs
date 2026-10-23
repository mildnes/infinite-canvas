import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { nodeSizeFromRatio } from "./canvas-node-size.ts";

const pageSource = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const pageAst = ts.createSourceFile("canvas.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const applyNodeConfigPatch = pageAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "applyNodeConfigPatch");
assert.ok(applyNodeConfigPatch, "applyNodeConfigPatch must exist");

function patchNode(node, patch) {
    const source = ts.transpileModule(`globalThis.applyNodeConfigPatch = ${applyNodeConfigPatch.getText(pageAst)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const context = {
        CanvasNodeType: { Image: "image", Panorama: "panorama", Video: "video" },
        NODE_DEFAULT_SIZE: {
            image: { width: 340, height: 240 },
            panorama: { width: 800, height: 400 },
            video: { width: 420, height: 236 },
        },
        PANORAMA_IMAGE_SIZE: "2:1",
        nodeSizeFromRatio,
        isPanoramaNodeType: (type) => type === "panorama",
        isCanvasImageNodeType: (type) => type === "image" || type === "panorama",
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    return context.applyNodeConfigPatch(node, patch);
}

function center(node) {
    return { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
}

test("video ratio changes use the nodes longest side as the base and keep its center", () => {
    const node = { id: "video", type: "video", position: { x: 100, y: 200 }, width: 720, height: 1280, metadata: { size: "9:16" } };
    const before = center(node);
    const patch = patchNode(node, { size: "16:9" });

    assert.deepEqual({ width: patch.width, height: patch.height }, { width: 1280, height: 720 });
    assert.deepEqual(center(patch), before);
});

test("image and panorama ratio behavior remains based on their existing defaults", () => {
    const image = { id: "image", type: "image", position: { x: 20, y: 40 }, width: 720, height: 1280, metadata: {} };
    const imagePatch = patchNode(image, { size: "16:9" });
    assert.deepEqual(
        { width: imagePatch.width, height: imagePatch.height },
        nodeSizeFromRatio("16:9", 340, 240),
    );
    assert.deepEqual(center(imagePatch), center(image));

    const panorama = { id: "panorama", type: "panorama", position: { x: 30, y: 60 }, width: 800, height: 400, metadata: {} };
    const panoramaPatch = patchNode(panorama, { size: "16:9" });
    assert.deepEqual(
        { width: panoramaPatch.width, height: panoramaPatch.height },
        nodeSizeFromRatio("2:1", 800, 400),
    );
    assert.equal(panoramaPatch.metadata.size, "2:1");
});

test("nodes with existing media do not recalculate their size", () => {
    const node = { id: "video", type: "video", position: { x: 100, y: 200 }, width: 720, height: 1280, metadata: { content: "/api/files/a/content", size: "9:16" } };
    const patch = patchNode(node, { size: "16:9" });
    assert.equal(patch.width, 720);
    assert.equal(patch.height, 1280);
    assert.deepEqual(patch.position, node.position);
});
