import assert from "node:assert/strict";
import test from "node:test";
import sharedOutputCapabilityRules from "../../../shared/image-output-capability-rules.json" with { type: "json" };

import {
    hasImageOutputFormatContext,
    imageOutputCapabilityRules,
    imageOutputCapabilityForConfig,
    imageOutputCapabilityForWorkflowFields,
    normalizeImageOutputFormat,
    resolveImageOutputFormat,
    type ImageOutputConfig,
} from "./image-output-format";

test("legacy or invalid output format values resolve to auto", () => {
    assert.equal(normalizeImageOutputFormat(undefined), "auto");
    assert.equal(normalizeImageOutputFormat("png"), "auto");
    assert.equal(normalizeImageOutputFormat("jpeg"), "jpeg");
});

test("local OpenAI GPT Image models expose transparent PNG and JPG", () => {
    const capability = imageOutputCapabilityForConfig({
        channelMode: "local",
        imageModel: "gpt-image-2",
        imageChannelId: "openai",
        localChannels: [{ id: "openai", protocol: "openai", models: ["gpt-image-2"] }],
    });
    assert.deepEqual(capability, { formats: ["png-transparent", "jpeg"], defaultFormat: "png-transparent" });
});

test("GPT Image 1 mini, 1.5, and 2.5 model names keep the OpenAI capability", () => {
    for (const model of ["gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
        const capability = imageOutputCapabilityForConfig({
            channelMode: "local",
            model,
            localChannels: [{ id: "openai", protocol: "openai", models: [model] }],
        });
        assert.deepEqual(capability, { formats: ["png-transparent", "jpeg"], defaultFormat: "png-transparent" }, model);
    }
});

test("OpenAI GPT Image capability accepts only supported families and dated snapshots", () => {
    for (const model of ["gpt-image-9", "gpt-image-2-2026-10-04", "gpt-image-2.5-flare-2026-09-30"]) {
        assert.ok(imageOutputCapabilityForConfig({
            channelMode: "local",
            model,
            localChannels: [{ id: "openai", protocol: "openai", models: [model] }],
        }), model);
    }
    for (const model of ["gpt-image-2-unofficial", "gpt-image-1.5-preview", "gpt-image-2-2026-02-30"]) {
        assert.equal(imageOutputCapabilityForConfig({
            channelMode: "local",
            model,
            localChannels: [{ id: "openai", protocol: "openai", models: [model] }],
        }), null, model);
    }
});

test("local protocol/model inference comes from the shared backend rule file", () => {
    assert.deepEqual(imageOutputCapabilityRules, sharedOutputCapabilityRules.rules);
    const examples = [
        ["openai", "", "gpt-2.5-sunburst-2k", ["png-transparent", "jpeg"]],
        ["openai", "", "gpt-2.5-flare-2k", ["png-transparent", "jpeg"]],
        ["apimart", "", "gpt-image-2.5-sunburst", ["png-transparent", "jpeg"]],
        ["apimart", "", "gpt-image-2-official", ["png-transparent", "jpeg"]],
    ] as const;

    for (const [protocol, baseUrl, model, formats] of examples) {
        assert.deepEqual(imageOutputCapabilityForConfig({
            channelMode: "local",
            model,
            localChannels: [{ id: "channel", protocol, baseUrl, models: [model] }],
        }), { formats: [...formats], defaultFormat: "png-transparent" }, model);
    }
});

test("local APIMart declared GPT Image models expose transparent PNG and JPG while KIE stays JPEG-only", () => {
    const apimart = imageOutputCapabilityForConfig({
        channelMode: "local",
        imageModel: "gpt-image-2-official",
        localChannels: [{ id: "apimart", protocol: "apimart", models: ["gpt-image-2-official"] }],
    });
    const kie = imageOutputCapabilityForConfig({
        channelMode: "local",
        imageModel: "qwen2/text-to-image",
        localChannels: [{ id: "kie", protocol: "kie", models: ["qwen2/text-to-image"] }],
    });
    assert.deepEqual(apimart, { formats: ["png-transparent", "jpeg"], defaultFormat: "png-transparent" });
    assert.deepEqual(kie, { formats: ["jpeg"], defaultFormat: "jpeg" });
});

test("APIMart exposes transparent PNG only for its five declared normalized GPT Image models", () => {
    const models = [
        "gpt-image-1-official",
        "gpt-image-1.5-official",
        "gpt-image-2-official",
        "gpt-image-2.5-flare",
        "gpt-image-2.5-sunburst",
    ];
    for (const model of models) {
        assert.deepEqual(imageOutputCapabilityForConfig({
            channelMode: "local",
            model,
            localChannels: [{ id: "apimart", protocol: "apimart", models: [model] }],
        }), { formats: ["png-transparent", "jpeg"], defaultFormat: "png-transparent" }, model);
    }
    for (const model of ["gpt_image_1_official", "GPT-IMAGE-1.5-OFFICIAL", "gpt_image_2.5_flare", "gpt_image_2.5_sunburst"]) {
        assert.deepEqual(imageOutputCapabilityForConfig({
            channelMode: "local",
            model,
            localChannels: [{ id: "apimart", protocol: "apimart", models: [model] }],
        }), { formats: ["png-transparent", "jpeg"], defaultFormat: "png-transparent" }, model);
    }

    assert.deepEqual(imageOutputCapabilityForConfig({
        channelMode: "local",
        model: "gpt-image-1",
        localChannels: [{ id: "apimart", protocol: "apimart", models: ["gpt-image-1"] }],
    }), { formats: ["jpeg"], defaultFormat: "jpeg" });
    assert.deepEqual(imageOutputCapabilityForConfig({
        channelMode: "local",
        model: "seedream-5-0-lite",
        localChannels: [{ id: "apimart", protocol: "apimart", models: ["seedream-5-0-lite"] }],
    }), { formats: ["jpeg"], defaultFormat: "jpeg" });

    assert.equal(imageOutputCapabilityForConfig({
        channelMode: "local",
        model: "seedream-5-0-pro",
        localChannels: [{ id: "apimart", protocol: "apimart", models: ["seedream-5-0-pro"] }],
    }), null);
    for (const model of [
        "gpt-image-2",
        "gpt-image-2-ext",
        "gpt-image-2.5-ext",
        "gpt-image-2-official-extra",
        "gpt-image-2-preview",
        "gpt-image-2-unofficial",
        "gpt-image-2.5-flare-unofficial",
        "gpt-image-2.5-sunburst-extra",
        "gpt-image-1-unofficial",
        "gpt-image-1.5-preview",
    ]) {
        assert.equal(imageOutputCapabilityForConfig({
            channelMode: "local",
            model,
            localChannels: [{ id: "apimart", protocol: "apimart", models: [model] }],
        }), null, model);
    }
});

test("remote public capabilities take precedence over local APIMart inference", () => {
    const config: ImageOutputConfig = {
        channelMode: "remote",
        imageModel: "gpt-image-2-official",
        publicChannels: [{ id: "remote", protocol: "apimart", models: ["gpt-image-2-official"] }],
        localChannels: [{ id: "local", protocol: "apimart", models: ["gpt-image-2-official"] }],
    };
    assert.equal(imageOutputCapabilityForConfig(config), null);

    config.publicChannels![0].imageOutputCapabilities = {
        "gpt-image-2-official": { formats: ["jpeg"], defaultFormat: "jpeg" },
    };
    assert.deepEqual(imageOutputCapabilityForConfig(config), { formats: ["jpeg"], defaultFormat: "jpeg" });
});

test("an undeclared remote custom model keeps automatic output and resolves no format", () => {
    const config: ImageOutputConfig = {
        channelMode: "remote",
        imageModel: "custom-image-model",
        publicChannels: [{ id: "remote", models: ["custom-image-model"] }],
    };

    const capability = imageOutputCapabilityForConfig(config);
    assert.equal(capability, null);
    assert.deepEqual(resolveImageOutputFormat("png-transparent", capability), { format: "auto", fellBack: false });
});

test("a declared remote custom model resolves a transparent PNG selection", () => {
    const capability = imageOutputCapabilityForConfig({
        channelMode: "remote",
        imageModel: "custom-image-model",
        publicChannels: [{
            id: "remote",
            models: ["custom-image-model"],
            imageOutputCapabilities: { "custom-image-model": { formats: ["png-transparent"], defaultFormat: "png-transparent" } },
        }],
    });

    assert.deepEqual(capability, { formats: ["png-transparent"], defaultFormat: "png-transparent" });
    assert.deepEqual(resolveImageOutputFormat("png-transparent", capability), { format: "png-transparent", fellBack: false });
});

test("local OpenAI compatible xAI endpoints do not advertise output formats", () => {
    const capability = imageOutputCapabilityForConfig({
        channelMode: "local",
        imageModel: "gpt-image-1",
        localChannels: [{ id: "xai", protocol: "openai", baseUrl: "https://api.x.ai/v1", models: ["gpt-image-1"] }],
    });
    assert.equal(capability, null);
});

test("local channel declarations override inference and an empty declaration disables formats", () => {
    const declared = imageOutputCapabilityForConfig({
        channelMode: "local",
        model: "gpt-image-2",
        imageChannelId: "openai",
        localChannels: [{
            id: "openai",
            protocol: "openai",
            models: ["gpt-image-2"],
            imageOutputCapabilities: { "gpt-image-2": { formats: ["jpeg"], defaultFormat: "jpeg" } },
        }],
    });
    const disabled = imageOutputCapabilityForConfig({
        channelMode: "local",
        model: "gpt-image-2",
        imageChannelId: "openai",
        localChannels: [{
            id: "openai",
            protocol: "openai",
            models: ["gpt-image-2"],
            imageOutputCapabilities: { "gpt-image-2": { formats: [] } },
        }],
    });

    assert.deepEqual(declared, { formats: ["jpeg"], defaultFormat: "jpeg" });
    assert.deepEqual(disabled, { formats: [] });
});

test("remote channel uses its declared capability and selected-channel identity", () => {
    const config: ImageOutputConfig = {
        channelMode: "remote" as const,
        imageModel: "same-model",
        imageChannelId: "jpeg-only",
        publicChannels: [
            { id: "png-and-jpeg", models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["png-transparent", "jpeg"], defaultFormat: "png-transparent" } } },
            { id: "jpeg-only", models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["jpeg"], defaultFormat: "jpeg" } } },
        ],
    };
    assert.deepEqual(imageOutputCapabilityForConfig(config), { formats: ["jpeg"], defaultFormat: "jpeg" });
    assert.equal(hasImageOutputFormatContext(config), true);
});

test("automatic routing exposes only formats shared by every candidate channel", () => {
    const capability = imageOutputCapabilityForConfig({
        channelMode: "remote",
        imageModel: "same-model",
        publicChannels: [
            { id: "first", models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["png-transparent", "jpeg"], defaultFormat: "png-transparent" } } },
            { id: "second", models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["jpeg"], defaultFormat: "jpeg" } } },
        ],
    });
    assert.deepEqual(capability, { formats: ["jpeg"], defaultFormat: "jpeg" });
});

test("automatic routing retains transparent PNG only when every candidate supports it", () => {
    const capability = imageOutputCapabilityForConfig({
        channelMode: "remote",
        imageModel: "same-model",
        publicChannels: [
            { id: "transparent-only", models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["png-transparent"], defaultFormat: "png-transparent" } } },
            { id: "both-formats", models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["png-transparent", "jpeg"], defaultFormat: "png-transparent" } } },
        ],
    });
    assert.deepEqual(capability, { formats: ["png-transparent"], defaultFormat: "png-transparent" });
});

test("disabled channels do not contribute output capabilities", () => {
    const capability = imageOutputCapabilityForConfig({
        channelMode: "remote",
        imageModel: "same-model",
        publicChannels: [
            { id: "disabled", enabled: false, models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["png-transparent"], defaultFormat: "png-transparent" } } },
            { id: "enabled", enabled: true, models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["jpeg"], defaultFormat: "jpeg" } } },
        ],
    });
    assert.deepEqual(capability, { formats: ["jpeg"], defaultFormat: "jpeg" });
});

test("workflow output capability is resolved only from the referenced channel and workflow", () => {
    const config: ImageOutputConfig = {
        channelMode: "remote",
        imageModel: "ordinary-model",
        imageWorkflowRef: { scope: "personal" as const, channelId: "local-workflow-channel", kind: "app" as const, workflowId: "image-workflow" },
        publicChannels: [{ id: "remote-model", models: ["ordinary-model"], imageOutputCapabilities: { "ordinary-model": { formats: ["png-transparent"], defaultFormat: "png-transparent" } } }],
        localChannels: [{
            id: "local-workflow-channel",
            workflowSummaries: [
                { kind: "app", workflowId: "other-workflow", imageOutputCapability: { formats: ["png-transparent"], defaultFormat: "png-transparent" } },
                { kind: "app", workflowId: "image-workflow", imageOutputCapability: { formats: ["jpeg"], defaultFormat: "jpeg" } },
            ],
        }],
    };
    assert.deepEqual(imageOutputCapabilityForConfig(config), { formats: ["jpeg"], defaultFormat: "jpeg" });
    assert.equal(hasImageOutputFormatContext(config), true);
});

test("workflow without declared format capability does not inherit model capability", () => {
    const config: ImageOutputConfig = {
        channelMode: "remote",
        imageModel: "ordinary-model",
        imageWorkflowRef: { scope: "system" as const, channelId: "workflow-channel", kind: "workflow" as const, workflowId: "explicit-default" },
        publicChannels: [{
            id: "workflow-channel",
            models: ["ordinary-model"],
            imageOutputCapabilities: { "ordinary-model": { formats: ["jpeg"], defaultFormat: "jpeg" } },
            workflows: [{ kind: "workflow", workflowId: "explicit-default" }],
        }],
    };
    assert.equal(imageOutputCapabilityForConfig(config), null);
    assert.equal(hasImageOutputFormatContext(config), true);
});

test("a text active channel does not override image channel candidates", () => {
    const capability = imageOutputCapabilityForConfig({
        channelMode: "remote",
        imageModel: "same-model",
        activeChannelId: "text-channel",
        publicChannels: [
            { id: "image-png-jpeg", models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["png-transparent", "jpeg"], defaultFormat: "png-transparent" } } },
            { id: "image-jpeg", models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["jpeg"], defaultFormat: "jpeg" } } },
            { id: "text-channel", models: ["text-model"], imageOutputCapabilities: { "same-model": { formats: ["png-transparent"], defaultFormat: "png-transparent" } } },
        ],
    });
    assert.deepEqual(capability, { formats: ["jpeg"], defaultFormat: "jpeg" });
});

test("an active channel selects output capability when it also serves the image model", () => {
    const capability = imageOutputCapabilityForConfig({
        channelMode: "remote",
        imageModel: "same-model",
        activeChannelId: "image-png",
        publicChannels: [
            { id: "image-png", models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["png-transparent"], defaultFormat: "png-transparent" } } },
            { id: "image-jpeg", models: ["same-model"], imageOutputCapabilities: { "same-model": { formats: ["jpeg"], defaultFormat: "jpeg" } } },
        ],
    });
    assert.deepEqual(capability, { formats: ["png-transparent"], defaultFormat: "png-transparent" });
});

test("workflow format capabilities require enabled and overridable explicit output mappings", () => {
    const capability = imageOutputCapabilityForWorkflowFields([
        { nodeId: "1", fieldName: "format", source: "outputFormat", options: ["png", "jpg"] },
        { nodeId: "2", fieldName: "transparent", source: "transparentBackground", fieldType: "BOOLEAN" },
    ]);
    assert.deepEqual(capability, { formats: ["png-transparent", "jpeg"], defaultFormat: "png-transparent" });
    assert.deepEqual(imageOutputCapabilityForWorkflowFields([
        { nodeId: "1", fieldName: "format", source: "imageOutputFormat", options: [{ label: "JPEG", value: "jpeg" }], enabled: false },
    ]), undefined);
    assert.deepEqual(imageOutputCapabilityForWorkflowFields([
        { nodeId: "1", fieldName: "format", source: "outputFormat", options: ["png", "jpg"] },
        { nodeId: "2", fieldName: "transparent", source: "transparentBackground", fieldType: "BOOLEAN", safeToOverride: false },
    ]), { formats: ["jpeg"], defaultFormat: "jpeg" });
    assert.deepEqual(imageOutputCapabilityForWorkflowFields([
        { nodeId: "1", fieldName: "format", source: "outputFormat" },
    ]), undefined);
    assert.deepEqual(imageOutputCapabilityForWorkflowFields([
        { nodeId: "1", fieldName: "format", source: "outputFormat", options: ["jpg"] },
        { nodeId: "2", fieldName: "transparent", source: "transparentBackground", fieldType: "BOOLEAN", options: ["true"] },
    ]), undefined);
});

test("unsupported selected format falls back to the channel default", () => {
    assert.deepEqual(resolveImageOutputFormat("png-transparent", { formats: ["jpeg"], defaultFormat: "jpeg" }), { format: "jpeg", fellBack: true, notice: "fallback-default" });
    assert.deepEqual(resolveImageOutputFormat("auto", { formats: ["jpeg"], defaultFormat: "jpeg" }), { format: "auto", fellBack: false });
    assert.deepEqual(resolveImageOutputFormat("png-transparent", { formats: [], defaultFormat: "jpeg" }), { format: "auto", fellBack: true, notice: "fallback-default" });
    assert.deepEqual(resolveImageOutputFormat("png-transparent", { formats: ["jpeg"] }), { format: "auto", fellBack: true, notice: "fallback-default" });
    assert.deepEqual(resolveImageOutputFormat("auto", { formats: [] }), { format: "auto", fellBack: false });
});
