import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { requestEdit, requestGeneration } from "./image";

const reference = {
    id: "reference",
    name: "source.png",
    type: "image/png",
    dataUrl: "data:image/png;base64,iVBORw0KGgo=",
};

function configFor(model: string, protocol: "gemini" | "openai" = "gemini"): AiConfig {
    return {
        ...defaultConfig,
        channelMode: "local",
        baseUrl: "https://gemini.example",
        apiKey: "{{SECRET_hb4env33}}",
        model,
        imageModel: model,
        videoModel: "",
        textModel: "",
        audioModel: "",
        activeChannelId: "channel",
        imageChannelId: "channel",
        count: "1",
        localChannels: [{
            id: "channel",
            protocol,
            name: "test channel",
            baseUrl: "https://gemini.example",
            apiKey: "{{SECRET_hb4env33}}",
            models: [model],
        }],
        publicChannels: [],
    };
}

async function sentBody(t: test.TestContext, config: AiConfig, run: "generate" | "edit") {
    const originalToken = useUserStore.getState().token;
    const originalWindow = globalThis.window;
    useUserStore.setState({ token: "" });
    globalThis.window = { location: { pathname: "/canvas/test" }, setTimeout, clearTimeout } as unknown as Window & typeof globalThis;
    t.after(() => {
        useUserStore.setState({ token: originalToken });
        if (originalWindow) globalThis.window = originalWindow;
        else Reflect.deleteProperty(globalThis, "window");
    });

    let request: RequestInit | undefined;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        request = init;
        return new Response(JSON.stringify({ error: { message: "test-stop" } }), { status: 400 });
    });
    await assert.rejects(() => run === "generate" ? requestGeneration(config, "scene") : requestEdit(config, "scene", [reference]));
    assert.ok(request, "image request should be sent");
    return JSON.parse(String(request.body)) as Record<string, unknown>;
}

test("Gemini native image requests put ratio and resolution in generationConfig.imageConfig", async (t) => {
    const cases = [
        { size: "1:1", quality: "low", aspectRatio: "1:1", imageSize: "1K" },
        { size: "16:9", quality: "medium", aspectRatio: "16:9", imageSize: "2K" },
        { size: "9:16", quality: "high", aspectRatio: "9:16", imageSize: "4K" },
        { size: "21:9", quality: "max", aspectRatio: "21:9", imageSize: "4K" },
    ];
    for (const scenario of cases) {
        const body = await sentBody(t, { ...configFor("gemini-3-pro-image-preview"), size: scenario.size, quality: scenario.quality }, "generate");
        const generationConfig = body.generationConfig as Record<string, unknown>;
        assert.deepEqual(generationConfig.imageConfig, {
            aspectRatio: scenario.aspectRatio,
            imageSize: scenario.imageSize,
        });
        assert.equal("responseFormat" in generationConfig, false);
    }
});

test("Gemini native image edits retain imageConfig and reference parts", async (t) => {
    const body = await sentBody(t, { ...configFor("gemini-3-pro-image-preview"), size: "16:9", quality: "medium" }, "edit");
    const generationConfig = body.generationConfig as Record<string, unknown>;
    assert.deepEqual(generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "2K" });
    assert.equal("responseFormat" in generationConfig, false);
    const contents = body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    assert.ok(contents[0].parts.some((part) => Boolean(part.inlineData)));
});

test("Gemini 2.5 image requests keep their existing aspect-only settings", async (t) => {
    const body = await sentBody(t, { ...configFor("gemini-2.5-flash-image"), size: "9:16", quality: "high" }, "generate");
    assert.deepEqual((body.generationConfig as Record<string, unknown>).imageConfig, { aspectRatio: "9:16" });
    assert.equal("responseFormat" in (body.generationConfig as Record<string, unknown>), false);
});

test("Agnes Image 2.x provider suffixes receive their ratio and resolution mapping", async (t) => {
    const cases = [
        { model: "agnes-image-2.1-flash", size: "16:9", quality: "low", expectedSize: "2K" },
        { model: "agnes-image-2.1-flash-preview", size: "9:16", quality: "medium", expectedSize: "3K" },
        { model: "agnes-image-2.5-flash", size: "21:9", quality: "high", expectedSize: "4K" },
        { model: "Agnes Image 2.5 Flash", size: "4:3", quality: "xhigh", expectedSize: "4K" },
    ];
    for (const scenario of cases) {
        const body = await sentBody(t, {
            ...configFor(scenario.model, "openai"),
            size: scenario.size,
            quality: scenario.quality,
        }, "generate");
        assert.equal(body.ratio, scenario.size, scenario.model);
        assert.equal(body.size, scenario.expectedSize, scenario.model);
        assert.equal("model" in body, true);
        assert.equal("prompt" in body, true);
    }
});
