import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { message } from "antd";
import { defaultConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { requestDirectImages } from "./direct-ai";

test("local direct translation receives declarations and never receives the provider key", async (t) => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { pathname: "/image" }, setTimeout, clearTimeout } as unknown as Window & typeof globalThis;
    t.after(() => {
        if (originalWindow) globalThis.window = originalWindow;
        else Reflect.deleteProperty(globalThis, "window");
    });
    const imageOutputCapabilities = { "custom-renderer": { formats: ["png-transparent" as const], defaultFormat: "png-transparent" as const } };
    const modelMap = { "custom-renderer": "gpt-image-2" };
    const channel = { id: "local", name: "local APIMart", protocol: "apimart" as const, baseUrl: "https://api.apimart.ai", apiKey: "provider-secret", models: ["custom-renderer"], modelMap, imageOutputCapabilities };
    let translation: Record<string, unknown> | undefined;
    t.mock.method(axios, "request", async (request: { data: Record<string, unknown> }) => {
        translation = request.data;
        return { status: 200, data: { code: 0, data: { provider: "apimart", url: "https://api.apimart.ai/v1/images/generations", contentType: "application/json", body: request.data.body }, msg: "" } };
    });
    let upstream: RequestInit | undefined;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        upstream = init;
        return new Response(JSON.stringify({ data: [{ url: "https://media.example/image.png" }] }));
    });
    const body = { model: "custom-renderer", prompt: "test", output_format: "png", background: "transparent" };
    const result = await requestDirectImages({ ...defaultConfig, channelMode: "local", model: "custom-renderer", imageModel: "custom-renderer", imageChannelId: "local", localChannels: [channel] }, "apimart", "/images/generations", body, 10);
    assert.deepEqual(translation?.channel, { protocol: channel.protocol, baseUrl: channel.baseUrl, name: channel.name, models: channel.models, modelMap, imageOutputCapabilities, imageQualityCapabilities: undefined });
    assert.equal(JSON.stringify(translation).includes("provider-secret"), false);
    assert.deepEqual(JSON.parse(String(upstream?.body)), body);
    assert.equal(new Headers(upstream?.headers).get("Authorization"), "Bearer provider-secret");
    assert.equal(result.data[0].url, "https://media.example/image.png");
});

test("可操作的输出格式回退提示每次请求只提示一次，过期账号或页面抑制提示", async (t) => {
    const originalWindow = globalThis.window;
    const originalSession = { token: useUserStore.getState().token, user: useUserStore.getState().user };
    globalThis.window = { location: { pathname: "/canvas/original" }, setTimeout, clearTimeout } as unknown as Window & typeof globalThis;
    t.after(() => {
        useUserStore.setState(originalSession);
        if (originalWindow) globalThis.window = originalWindow;
        else Reflect.deleteProperty(globalThis, "window");
    });
    const messages: unknown[] = [];
    t.mock.method(message, "info", (notice: unknown) => { messages.push(notice); });
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [{ url: "https://media.example/image.png" }] })));
    let change: "none" | "account" | "page" = "none";
    t.mock.method(axios, "request", async () => {
        if (change === "account") useUserStore.setState({ token: "other-account" });
        if (change === "page") window.location.pathname = "/canvas/other";
        return { status: 200, data: { code: 0, data: { provider: "apimart", url: "https://api.apimart.ai/v1/images/generations", contentType: "application/json", body: { prompt: "test" }, imageOutputNoticeCode: "fallback-default" }, msg: "" } };
    });
    const config = { ...defaultConfig, channelMode: "local" as const, model: "custom-renderer", imageModel: "custom-renderer", imageChannelId: "local", localChannels: [{ id: "local", name: "local", protocol: "apimart" as const, baseUrl: "https://api.apimart.ai", apiKey: "provider-secret", models: ["custom-renderer"] }] };
    for (const scenario of ["none", "account", "page"] as const) {
        change = scenario;
        useUserStore.setState({ token: "original-account" });
        window.location.pathname = "/canvas/original";
        const before = messages.length;
        await requestDirectImages(config, "apimart", "/images/generations", { prompt: "test" }, 10);
        assert.equal(messages.length - before, scenario === "none" ? 1 : 0, scenario);
    }
});

test("未声明输出格式能力的提示不再逐次弹出（纯信息性提示降噪）", async (t) => {
    const originalWindow = globalThis.window;
    const originalSession = { token: useUserStore.getState().token, user: useUserStore.getState().user };
    globalThis.window = { location: { pathname: "/canvas/original" }, setTimeout, clearTimeout } as unknown as Window & typeof globalThis;
    t.after(() => {
        useUserStore.setState(originalSession);
        if (originalWindow) globalThis.window = originalWindow;
        else Reflect.deleteProperty(globalThis, "window");
    });
    const messages: unknown[] = [];
    t.mock.method(message, "info", (notice: unknown) => { messages.push(notice); });
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [{ url: "https://media.example/image.png" }] })));
    t.mock.method(axios, "request", async () => ({ status: 200, data: { code: 0, data: { provider: "apimart", url: "https://api.apimart.ai/v1/images/generations", contentType: "application/json", body: { prompt: "test" }, imageOutputNoticeCode: "undeclared" }, msg: "" } }));
    const config = { ...defaultConfig, channelMode: "local" as const, model: "custom-renderer", imageModel: "custom-renderer", imageChannelId: "local", localChannels: [{ id: "local", name: "local", protocol: "apimart" as const, baseUrl: "https://api.apimart.ai", apiKey: "provi...et", models: ["custom-renderer"] }] };
    useUserStore.setState({ token: "original-account" });
    window.location.pathname = "/canvas/original";
    await requestDirectImages(config, "apimart", "/images/generations", { prompt: "test" }, 10);
    await requestDirectImages(config, "apimart", "/images/generations", { prompt: "test" }, 10);
    assert.equal(messages.length, 0);
});
