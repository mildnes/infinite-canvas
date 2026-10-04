import assert from "node:assert/strict";
import test from "node:test";

import { channelIdForActiveModel, filterChannelModelsByCapability, modelMatchesCapability } from "./use-config-store.ts";

test("声明的模型能力优先于模型名称识别", () => {
    const capabilities = { "acme-renderer-v7": ["image"] };

    assert.equal(modelMatchesCapability("acme-renderer-v7", "image", "openai", capabilities), true);
    assert.equal(modelMatchesCapability("acme-renderer-v7", "text", "openai", capabilities), false);
});

test("显式空能力列表阻止旧名称规则覆盖声明", () => {
    assert.equal(modelMatchesCapability("gpt-image-custom", "image", "openai", { "gpt-image-custom": [] }), false);
});

test("只有缺少模型声明时才使用旧名称规则，且键名大小写精确匹配", () => {
    assert.equal(modelMatchesCapability("gpt-image-custom", "image", "openai", {}), true);
    assert.equal(modelMatchesCapability("gpt-image-custom", "image", "openai", { "GPT-IMAGE-CUSTOM": ["text"] }), true);
});

test("相同模型名按渠道声明分别归入能力", () => {
    const channels = [
        { id: "image", models: ["shared-model"], modelCapabilities: { "shared-model": ["image"] } },
        { id: "text", models: ["shared-model"], modelCapabilities: { "shared-model": ["text"] } },
    ];

    assert.deepEqual(filterChannelModelsByCapability(channels, "image"), ["shared-model"]);
    assert.deepEqual(filterChannelModelsByCapability(channels, "text"), ["shared-model"]);
    assert.deepEqual(filterChannelModelsByCapability(channels, "video"), []);
});

test("主动渠道解析按声明能力选择自定义图片模型渠道", () => {
    const config = {
        channelMode: "remote",
        model: "acme-renderer-v7",
        imageModel: "acme-renderer-v7",
        videoModel: "video-model",
        audioModel: "audio-model",
        textModel: "text-model",
        imageChannelId: "image-channel",
        videoChannelId: "video-channel",
        audioChannelId: "audio-channel",
        textChannelId: "text-channel",
        activeChannelId: "",
        publicChannels: [
            { id: "image-channel", models: ["acme-renderer-v7"], modelCapabilities: { "acme-renderer-v7": ["image"] } },
            { id: "text-channel", models: ["acme-renderer-v7"], modelCapabilities: { "acme-renderer-v7": ["text"] } },
        ],
    };

    assert.equal(channelIdForActiveModel(config), "image-channel");
});
