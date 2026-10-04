import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

import {
    applyImageOutputFormatFields,
    applyImageOutputFormatRequestBody,
    normalizeBase64Image,
    createCanvasImageTask,
    requestEdit,
    requestGeneration,
} from "./image";

test("real image entry points use remote declarations without guessing custom model names", async (t) => {
    const originalToken = useUserStore.getState().token;
    const originalWindow = globalThis.window;
    useUserStore.setState({ token: "test-token" });
    globalThis.window = { location: { pathname: "/canvas/test" }, setTimeout, clearTimeout } as unknown as Window & typeof globalThis;
    t.after(() => {
        useUserStore.setState({ token: originalToken });
        if (originalWindow) globalThis.window = originalWindow;
        else Reflect.deleteProperty(globalThis, "window");
    });
    const sentRequests: RequestInit[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        sentRequests.push(init);
        return new Response(JSON.stringify({ error: { message: "test-stop" } }), { status: 400 });
    });
    const reference = { id: "ref", name: "source.png", type: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
    for (const declared of [false, true]) {
        for (const apiMode of ["images", "responses"]) {
            for (const run of [requestGeneration, requestEdit, createCanvasImageTask]) {
                const config = {
                    ...defaultConfig, channelMode: "remote" as const, model: "my-custom-alias", imageModel: "my-custom-alias",
                    apiMode, count: "2", imageChannelId: "selected", imageOutputFormat: "png-transparent" as const,
                    publicChannels: [{ id: "selected", protocol: "openai" as const, name: "selected", models: ["my-custom-alias"],
                        ...(declared ? { imageOutputCapabilities: { "my-custom-alias": { formats: ["png-transparent" as const], defaultFormat: "png-transparent" as const } } } : {}),
                    }],
                };
                sentRequests.length = 0;
                await assert.rejects(() => run(config, "scene", run === requestEdit ? [reference] : []));
                const sent = sentRequests[0];
                assert.ok(sent);
                if (sent.body instanceof FormData) {
                    assert.equal(sent.body.get("output_format"), declared ? "png" : null);
                    assert.equal(sent.body.get("background"), declared ? "transparent" : null);
                    assert.equal((sent.body.get("image") as File).size, 8);
                } else {
                    const body = JSON.parse(String(sent.body));
                    const request = body.request || body;
                    const target = apiMode === "responses" ? request.tools[0] : request;
                    assert.equal(target.output_format, declared ? "png" : undefined);
                    assert.equal(target.background, declared ? "transparent" : undefined);
                }
            }
        }
    }
});

test("Images, Responses, and Chat place selected format in protocol-specific targets", () => {
    const imagesBody = applyImageOutputFormatRequestBody({ model: "gpt-image-2" }, "png-transparent", "openai");
    assert.deepEqual(imagesBody, { model: "gpt-image-2", output_format: "png", background: "transparent" });

    const responsesBody = applyImageOutputFormatRequestBody({
        model: "gpt-image-2",
        tools: [{ type: "image_generation" }],
    }, "jpeg", "openai", "responses");
    assert.deepEqual(responsesBody, {
        model: "gpt-image-2",
        tools: [{ type: "image_generation", output_format: "jpeg" }],
    });

    const chatBody = applyImageOutputFormatRequestBody({
        model: "gpt-image-2",
        modalities: ["image", "text"],
        image_config: { aspect_ratio: "1:1", image_size: "2K" },
    }, "png-transparent", "openai", "chat");
    assert.deepEqual(chatBody.image_config, {
        aspect_ratio: "1:1",
        image_size: "2K",
        output_format: "png",
        background: "transparent",
    });
    assert.equal("output_format" in chatBody, false);
});

test("auto and ordinary text Chat requests keep their existing fields", () => {
    const body = { model: "gpt-image-2", response_format: "b64_json" };
    assert.deepEqual(applyImageOutputFormatRequestBody(body, undefined, "openai"), body);
    const selectedBody = applyImageOutputFormatRequestBody({ ...body }, "jpeg", "openai");
    assert.equal(selectedBody.response_format, "b64_json");
    assert.equal(selectedBody.output_format, "jpeg");
    const textBody = { model: "gpt-image-2", messages: [{ role: "user", content: "hello" }] };
    assert.deepEqual(applyImageOutputFormatRequestBody(textBody, "jpeg", "openai", "chat"), textBody);
});

test("APIMart Images emit transparent PNG and clean JPEG fields while KIE remains JPEG-only", () => {
    assert.deepEqual(applyImageOutputFormatRequestBody({ model: "gpt-image-2-official" }, "png-transparent", "apimart"), {
        model: "gpt-image-2-official",
        output_format: "png",
        background: "transparent",
    });
    assert.deepEqual(applyImageOutputFormatFields({ background: "transparent" }, "jpeg", "apimart"), { output_format: "jpeg" });
    assert.deepEqual(applyImageOutputFormatFields({}, "jpeg", "kie"), { output_format: "jpg" });
    assert.deepEqual(applyImageOutputFormatFields({}, "png-transparent", "kie"), {});
    const apimartResponses = { tools: [{ type: "image_generation" }] };
    assert.deepEqual(applyImageOutputFormatRequestBody(apimartResponses, "png-transparent", "apimart", "responses"), apimartResponses);
    const apimartChat = { modalities: ["image", "text"], image_config: { aspect_ratio: "1:1" } };
    assert.deepEqual(applyImageOutputFormatRequestBody(apimartChat, "png-transparent", "apimart", "chat"), apimartChat);
    const kieResponses = { tools: [{ type: "image_generation" }] };
    assert.deepEqual(applyImageOutputFormatRequestBody(kieResponses, "jpeg", "kie", "responses"), kieResponses);
    const autoBody = { model: "gpt-image-2-official", background: "existing" };
    assert.deepEqual(applyImageOutputFormatRequestBody(autoBody, null, "apimart"), autoBody);
});

test("Grok2API and xAI do not receive image output format fields", () => {
    for (const protocol of ["grok2api", "xai"]) {
        const body = { model: "grok-imagine-image-2.0", size: "1024x1024" };
        assert.deepEqual(applyImageOutputFormatFields(body, "jpeg", protocol), body);
        assert.equal("output_format" in body, false);
        assert.equal("background" in body, false);
    }
});

test("actual image bytes override requested and declared MIME types", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64");
    assert.equal(normalizeBase64Image(`data:image/jpeg;base64,${png}`, "image/jpeg"), `data:image/png;base64,${png}`);
    assert.equal(normalizeBase64Image(jpeg, "image/png"), `data:image/jpeg;base64,${jpeg}`);
});
