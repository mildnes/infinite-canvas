import assert from "node:assert/strict";
import test from "node:test";

import { applyCanvasAgentImageSelection, resolveCanvasAgentImageSelection } from "./canvas-agent-image-model.ts";

const config = {
    channelMode: "remote",
    imageModel: "gpt-image-2",
    imageChannelId: "default",
    imageModels: ["gpt-image-2", "grok-imagine-image"],
    publicChannels: [
        { id: "default", models: ["gpt-image-2"] },
        { id: "grok-a", models: ["grok-imagine-image"] },
        { id: "grok-b", models: ["grok-imagine-image"] },
    ],
};

test("保留同名图片模型指定的渠道", () => {
    assert.deepEqual(resolveCanvasAgentImageSelection(config, { imageModel: "grok-imagine-image", imageChannelId: "grok-b" }), {
        imageModel: "grok-imagine-image",
        imageChannelId: "grok-b",
    });
});

test("已下线模型回退到当前默认图片模型", () => {
    assert.deepEqual(resolveCanvasAgentImageSelection(config, { imageModel: "removed-image-model", imageChannelId: "removed" }), {
        imageModel: "gpt-image-2",
        imageChannelId: "default",
    });
});

test("将 Agent 选择的图片模型和渠道应用到本次生成配置", () => {
    const selection = resolveCanvasAgentImageSelection(config, { imageModel: "grok-imagine-image", imageChannelId: "grok-b" });
    const generationConfig = applyCanvasAgentImageSelection(config, selection);

    assert.equal(generationConfig.imageModel, "grok-imagine-image");
    assert.equal(generationConfig.imageChannelId, "grok-b");
});
