import assert from "node:assert/strict";
import test from "node:test";

import { applyCanvasAgentGenerationDefaults, applyCanvasAgentImageSelection, resolveCanvasAgentImageSelection } from "./canvas-agent-image-model.ts";

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

test("画布生成默认配置继承 Agent 的图片模型、渠道、质量和尺寸", () => {
    const generationDefaults = applyCanvasAgentGenerationDefaults(
        { ...config, quality: "auto", size: "3840x2160", vquality: "720", videoSize: "16:9" },
        {
            imageModel: "grok-imagine-image",
            imageChannelId: "grok-b",
            imageOutputFormat: "png-transparent",
            imageQuality: "high",
            imageSize: "2048x1152",
            videoQuality: "1080",
            videoSize: "9:16",
        },
    );

    assert.equal(generationDefaults.imageModel, "grok-imagine-image");
    assert.equal(generationDefaults.imageChannelId, "grok-b");
    assert.equal(generationDefaults.imageOutputFormat, "png-transparent");
    assert.equal(generationDefaults.quality, "high");
    assert.equal(generationDefaults.size, "2048x1152");
    assert.equal(generationDefaults.vquality, "1080");
    assert.equal(generationDefaults.videoSize, "9:16");
});

test("Agent 生成默认配置缺少字段时保留全局值", () => {
    const generationDefaults = applyCanvasAgentGenerationDefaults(
        { ...config, quality: "auto", size: "3840x2160", vquality: "720", videoSize: "16:9" },
        { imageQuality: "", imageSize: "", videoQuality: "", videoSize: "" },
    );

    assert.equal(generationDefaults.quality, "auto");
    assert.equal(generationDefaults.size, "3840x2160");
    assert.equal(generationDefaults.vquality, "720");
    assert.equal(generationDefaults.videoSize, "16:9");
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

test("remote 仅开放文本时 Agent 图片选择为空，应用选择不恢复旧图片模型", () => {
    const restricted = { ...config, imageModels: [], publicChannels: [{ id: "text", models: ["text-only"], modelCapabilities: { "text-only": ["text"] } }] };
    const selection = resolveCanvasAgentImageSelection(restricted, { imageModel: "gpt-image-2", imageChannelId: "default" });
    assert.equal(selection.imageModel, "");
    assert.equal(selection.imageChannelId, "");
    assert.equal(applyCanvasAgentImageSelection(restricted, selection).imageModel, "");
});

test("local 无图片候选仍保留原 Agent 图片兜底", () => {
    const local = { ...config, channelMode: "local", localChannels: [], models: [], imageModels: [] };
    assert.equal(resolveCanvasAgentImageSelection(local).imageModel, config.imageModel);
    assert.equal(applyCanvasAgentImageSelection(local, { imageModel: "", imageChannelId: "" }).imageModel, config.imageModel);
});
