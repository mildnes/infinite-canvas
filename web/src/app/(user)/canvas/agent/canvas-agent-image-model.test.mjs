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
    assert.deepEqual(resolveCanvasAgentImageSelection(config, { imageModel: "grok-imagine-image", imageChannelId: "grok-b", imageOutputFormat: "jpeg" }), {
        imageModel: "grok-imagine-image",
        imageChannelId: "grok-b",
        imageOutputFormat: "jpeg",
    });
});

test("已下线模型回退到当前默认图片模型", () => {
    assert.deepEqual(resolveCanvasAgentImageSelection(config, { imageModel: "removed-image-model", imageChannelId: "removed" }), {
        imageModel: "gpt-image-2",
        imageChannelId: "default",
        imageOutputFormat: "auto",
    });
});

test("将 Agent 选择的图片模型和渠道应用到本次生成配置", () => {
    const selection = resolveCanvasAgentImageSelection(config, { imageModel: "grok-imagine-image", imageChannelId: "grok-b", imageOutputFormat: "png-transparent" });
    const generationConfig = applyCanvasAgentImageSelection(config, selection);

    assert.equal(generationConfig.imageModel, "grok-imagine-image");
    assert.equal(generationConfig.imageChannelId, "grok-b");
    assert.equal(generationConfig.imageOutputFormat, "png-transparent");
});

test("旧 Agent 配置缺少格式时保持 auto，不继承新的全局默认格式", () => {
    const selection = resolveCanvasAgentImageSelection({ ...config, imageOutputFormat: "png-transparent" }, {
        imageModel: "grok-imagine-image",
        imageChannelId: "grok-b",
    });

    assert.equal(selection.imageOutputFormat, "auto");
});

test("新 Agent 配置未单独指定格式时沿用当前默认格式", () => {
    const selection = resolveCanvasAgentImageSelection({ ...config, imageOutputFormat: "png-transparent" });

    assert.equal(selection.imageOutputFormat, "png-transparent");
});

test("自定义本地名按映射的上游名识别图片能力", () => {
    const aliasConfig = { ...config, imageModels: [], publicChannels: [{ id: "rolldek", models: ["我的高质图"], modelMap: { "我的高质图": "gpt-image-2.5-sunburst" } }] };
    assert.deepEqual(resolveCanvasAgentImageSelection(aliasConfig, { imageModel: "我的高质图", imageChannelId: "rolldek" }), {
        imageModel: "我的高质图",
        imageChannelId: "rolldek",
        imageOutputFormat: "auto",
    });
});
