import assert from "node:assert/strict";
import test from "node:test";

import { channelIdForActiveModel, filterChannelModelsByCapability, modelMatchesCapability, normalizeLocalChannels } from "./use-config-store.ts";

test("本地渠道规范化和恢复保留输出声明与显式空格式，按渠道隔离", () => {
    const channels = [
        { id: "allowed", models: ["custom-renderer"], imageOutputCapabilities: { "custom-renderer": { formats: ["png-transparent"], defaultFormat: "png-transparent" } } },
        { id: "disabled", models: ["custom-renderer"], imageOutputCapabilities: { "custom-renderer": { formats: [] } } },
        { id: "legacy", models: ["custom-renderer"] },
    ];
    const restored = normalizeLocalChannels(JSON.parse(JSON.stringify({ localChannels: channels })));
    for (let i = 0; i < channels.length; i++) assert.deepEqual(restored[i].imageOutputCapabilities, channels[i].imageOutputCapabilities);
});

test("声明的模型能力优先于模型名称识别", () => {
    const capabilities = { "acme-renderer-v7": ["image"] };

    assert.equal(modelMatchesCapability("acme-renderer-v7", "image", "openai", capabilities), true);
    assert.equal(modelMatchesCapability("acme-renderer-v7", "text", "openai", capabilities), false);
});

test("自定义本地名按渠道映射的上游名兜底识别图片能力", () => {
    const channel = { models: ["我的高质图"], modelMap: { "我的高质图": "gpt-image-2.5-sunburst" } };
    assert.equal(modelMatchesCapability("我的高质图", "image", "openai", undefined, channel.modelMap), true);
    assert.deepEqual(filterChannelModelsByCapability([channel], "image"), ["我的高质图"]);
});

test("渠道模型映射在规范化与 JSON 恢复中保留，本地可选模型和能力不改名", () => {
    const input = { id: "mapped", models: ["custom-renderer", "other"], modelMap: { "custom-renderer": "upstream-renderer", other: "upstream-renderer" }, modelCapabilities: { "custom-renderer": ["image"] } };
    const [channel] = normalizeLocalChannels(JSON.parse(JSON.stringify({ localChannels: [input] })));
    assert.deepEqual(channel.modelMap, input.modelMap);
    assert.deepEqual(channel.models, input.models);
    assert.deepEqual(channel.modelCapabilities, input.modelCapabilities);
    assert.deepEqual(filterChannelModelsByCapability([channel], "image"), ["custom-renderer"]);
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

test("自定义图片别名按上游名识别，不再被当作文本模型", () => {
    const modelMap = { "我的高质图": "gpt-image-2.5-sunburst" };
    assert.equal(modelMatchesCapability("我的高质图", "image", "openai", undefined, modelMap), true);
    assert.equal(modelMatchesCapability("我的高质图", "text", "openai", undefined, modelMap), false);
    assert.equal(modelMatchesCapability("我的高质图", "text", "openai", { "我的高质图": ["text"] }, modelMap), true);
});
