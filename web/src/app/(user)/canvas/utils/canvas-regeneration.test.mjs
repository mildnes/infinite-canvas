import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareCanvasNodeOverwrite, shouldOverwriteCanvasNode } from "./canvas-regeneration.ts";

const source = new URL("../../../../", import.meta.url);
const configStore = readFileSync(new URL("stores/use-config-store.ts", source), "utf8");
const configModal = readFileSync(new URL("components/layout/app-config-modal.tsx", source), "utf8");
const canvasPage = readFileSync(new URL("app/(user)/canvas/[id]/canvas-client-page.tsx", source), "utf8");

test("canvas regeneration mode defaults to new-node and is wired to overwrite only matching non-batch nodes", () => {
    assert.ok(/nodeRegenerateBehavior:\s*"new-node"\s*\|\s*"overwrite"/.test(configStore), "AiConfig must define the regeneration behavior");
    assert.ok(/nodeRegenerateBehavior:\s*"new-node"/.test(configStore), "the default must preserve derived-node behavior");
    assert.ok(/Radio\.Group/.test(configModal) && /覆盖当前节点/.test(configModal) && /新建衍生节点/.test(configModal), "preferences must expose both regeneration modes");
    assert.ok(/shouldOverwriteCanvasNode\(effectiveConfig\.nodeRegenerateBehavior,\s*mode,\s*sourceNode\)/.test(canvasPage), "the generation path must use the shared overwrite decision");
    assert.ok(/prepareCanvasNodeOverwrite/.test(canvasPage), "media overwrite must use the identity-preserving replacement");
    assert.ok(/editingTextNode && !overwriteExisting/.test(canvasPage), "text overwrite must bypass derived-node creation and run on the source");
});

test("overwrite mode reuses only a same-type non-batch source node", () => {
    const source = { id: "image-1", type: "image", metadata: {} };
    assert.equal(shouldOverwriteCanvasNode("new-node", "image", source), false);
    assert.equal(shouldOverwriteCanvasNode("overwrite", "video", source), false);
    assert.equal(shouldOverwriteCanvasNode("overwrite", "image", { ...source, metadata: { isBatchRoot: true } }), false);
    assert.equal(shouldOverwriteCanvasNode("overwrite", "image", source), true);
});

test("overwriting preserves node identity, geometry, title, group and unrelated metadata while clearing old media and task state", () => {
    const source = {
        id: "image-1",
        type: "image",
        title: "原节点标题",
        position: { x: 120, y: 240 },
        width: 720,
        height: 480,
        metadata: {
            groupId: "group-1",
            custom: "keep",
            content: "data:image/png;base64,old",
            storageKey: "server:old",
            mediaStatus: "ok",
            imageTaskId: "old-task",
            status: "success",
        },
    };
    const generated = {
        ...source,
        id: "image-new",
        title: "生成标题",
        position: { x: 0, y: 0 },
        width: 340,
        height: 240,
        metadata: { prompt: "新提示词", status: "loading", imageTaskId: "new-task" },
    };
    const result = prepareCanvasNodeOverwrite(source, generated);
    assert.equal(result.id, source.id);
    assert.equal(result.title, source.title);
    assert.deepEqual(result.position, source.position);
    assert.equal(result.width, source.width);
    assert.equal(result.height, source.height);
    assert.equal(result.metadata.groupId, "group-1");
    assert.equal(result.metadata.custom, "keep");
    assert.equal(result.metadata.content, undefined);
    assert.equal(result.metadata.storageKey, "");
    assert.equal(result.metadata.mediaStatus, undefined);
    assert.equal(result.metadata.imageTaskId, "new-task");
    assert.equal(result.metadata.status, "loading");
    assert.equal(result.metadata.prompt, "新提示词");
});
