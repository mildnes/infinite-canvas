import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { isAgnesVideoV25Model } from "../../lib/video-model-capabilities.ts";

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const source = readFileSync(new URL("./video.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("video.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const selected = new Set(["VideoRequestError", "agnesVideoV25ReferenceUrl", "publicHttpUrl", "createAgnesVideoV25RequestBody", "imageToAgnesReference", "elementReferenceToInputUrl"]);
const declarations = ast.statements.filter(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && selected.has(node.name?.text)).map(node => node.getText(ast).replace(/^export /, "")).join("\n");
const origin = "https://canvas.example:4443";
const image = (id, extra = {}) => ({ id, name: `${id}.png`, type: "image/png", dataUrl: "", storageKey: `server:${id}`, ...extra });
const media = (id, type, extra = {}) => ({ id, name: id, type, url: "", storageKey: `server:${id}`, ...extra });
const emptyInput = () => ({ firstFrame: null, lastFrame: null, references: [], audioReferences: [], videoReferences: [] });
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(pageOrigin = origin, overrides = {}) {
    const context = {
        URL, exports: {}, window: { location: { origin: pageOrigin } },
        resolveImageUrl: async (key, fallback) => key?.startsWith("server:") ? `/api/files/${key.slice(7)}/content` : fallback,
        resolveMediaUrl: async (key, fallback) => key?.startsWith("server:") ? `/api/files/${key.slice(7)}/content` : fallback,
        imageToDataUrl: async () => "data:image/png;base64,fixture",
        normalizeSeedanceRatio: value => value,
        formatErrorDetail: value => value,
        fetch: () => assert.fail("URL resolution must not probe or download media"),
        ...overrides,
    };
    const external = readFileSync(new URL("../../lib/external-media-url.ts", import.meta.url), "utf8");
    vm.runInNewContext(compile(external), context);
    Object.assign(context, context.exports);
    const helper = new URL("../../lib/same-origin-public-media-url.ts", import.meta.url);
    if (existsSync(helper)) {
        context.exports = {};
        vm.runInNewContext(compile(readFileSync(helper, "utf8")), context);
        Object.assign(context, context.exports);
    }
    vm.runInNewContext(compile(declarations), context);
    context.config = { size: "16:9", videoSeconds: "8" };
    context.build = input => context.createAgnesVideoV25RequestBody(context.config, "agnes-video-2.5-flash", "scene", { ...emptyInput(), ...input });
    return context;
}

test("公网页面的站内图片首帧与尾帧变为绝对 URL，请求体字段和模式不变", async () => {
    const f = fixture();
    const body = await f.build({ firstFrame: image("first"), lastFrame: image("last") });
    assert.deepEqual(plain(body), { model: "agnes-video-2.5-flash", prompt: "scene", mode: "keyframe", seconds: "8", size: "720P", aspect_ratio: "16:9", first_frame: `${origin}/api/files/first/content`, last_frame: `${origin}/api/files/last/content` });
});

test("参考图片、音频、视频全部使用同一修复，videos 仍为 URL 对象数组", async () => {
    const f = fixture();
    const body = await f.build({ references: [image("picture")], audioReferences: [media("audio", "audio/wav")], videoReferences: [media("video", "video/mp4")] });
    assert.deepEqual(plain(body), {
        model: "agnes-video-2.5-flash", prompt: "scene", mode: "reference", seconds: "8", size: "720P", aspect_ratio: "16:9",
        images: [`${origin}/api/files/picture/content`], audios: [`${origin}/api/files/audio/content`], videos: [{ url: `${origin}/api/files/video/content` }],
    });
});

test("原外部 URL 的 url → dataUrl → resolvedUrl 优先级高于新增同源分支", async () => {
    const f = fixture(origin, { resolveImageUrl: async () => "https://resolved.example/image.png" });
    assert.equal(await f.agnesVideoV25ReferenceUrl(image("id", { url: "https://first.example/image.png", dataUrl: "https://second.example/image.png" })), "https://first.example/image.png");
    assert.equal(await f.agnesVideoV25ReferenceUrl(image("id", { url: "/api/files/id/content", dataUrl: "https://second.example/image.png" })), "https://second.example/image.png");
    assert.equal(await f.agnesVideoV25ReferenceUrl(image("id", { url: "/api/files/id/content" })), "https://resolved.example/image.png");
    const internal = fixture();
    assert.equal(await internal.agnesVideoV25ReferenceUrl(image("resolved", { url: "/api/files/original/preview" })), `${origin}/api/files/original/preview`);
});

test("私网页面的五类站内参考均拒绝，并说明当前页面不是公网域名访问", async () => {
    for (const host of ["10.10.10.143", "127.0.0.1", "localhost", "192.168.1.2", "172.16.1.2", "canvas.local"]) {
        const f = fixture(`http://${host}:3000`);
        for (const input of [
            { firstFrame: image("id") }, { lastFrame: image("id") }, { references: [image("id")] },
            { audioReferences: [media("id", "audio/wav")] }, { videoReferences: [media("id", "video/mp4")] },
        ]) await assert.rejects(f.build(input), error => {
            assert.equal(error.name, "VideoRequestError");
            assert.ok(error.message.startsWith("Agnes Video 2.5 的参考素材必须具有公网访问地址"));
            assert.ok(error.message.includes("当前页面不是公网域名访问"), error.message);
            return true;
        });
    }
});

test("非媒体同源接口与 blob/data 不会被传入 Agnes，空参考与互斥校验保持原样", async () => {
    const f = fixture();
    for (const url of ["/api/user-data/assets/id/content", "/api/auth/login", "/api/files/id/content/extra", "blob:https://canvas.example:4443/id", "data:image/png;base64,AAAA"]) {
        await assert.rejects(f.agnesVideoV25ReferenceUrl(image("id", { storageKey: undefined, url, dataUrl: url })), /Agnes Video 2.5 的参考素材必须具有公网访问地址/);
        await assert.rejects(f.agnesVideoV25ReferenceUrl(media("id", "video/mp4", { storageKey: undefined, url })), /Agnes Video 2.5 的参考素材必须具有公网访问地址/);
    }
    assert.deepEqual(plain(await f.build({})), { model: "agnes-video-2.5-flash", prompt: "scene", mode: "text", seconds: "8", size: "720P", aspect_ratio: "16:9" });
    await assert.rejects(f.build({ firstFrame: image("first"), references: [image("picture")] }), /首尾帧不能和普通参考素材同时使用/);
});

test("同源放行仅进入 Agnes 2.5 分支，旧 Agnes 和其他视频元素参考保持原行为", async () => {
    const f = fixture();
    assert.equal(await f.imageToAgnesReference(image("id")), "data:image/png;base64,fixture");
    await assert.rejects(f.elementReferenceToInputUrl({ kind: "video", storageKey: "server:id", url: "" }), /视频元素参考素材必须具有公网访问地址/);
    assert.equal(f.publicHttpUrl("/api/files/id/content"), "");
    assert.equal(f.publicHttpUrl(`${origin}/api/files/id/content`), "");
    assert.equal(f.publicHttpUrl("https://cdn.example/image.png"), "https://cdn.example/image.png");
    assert.equal(f.publicHttpUrl("http://localhost:3000/api/files/id/content"), "");
    for (const model of ["agnes-video-2.5-flash", "agnes-video-2-5", "Agnes.Video.2.5"]) assert.equal(isAgnesVideoV25Model(model), true);
    assert.equal(isAgnesVideoV25Model("agnes-video-2-4"), false);
});

test("Agnes 图片编辑的站内参考仍降级为 base64，不沿用视频 URL 放行", async () => {
    const f = fixture();
    const imageSource = readFileSync(new URL("./image.ts", import.meta.url), "utf8");
    const imageAst = ts.createSourceFile("image.ts", imageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const edit = imageAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "requestAgnesImageEdit");
    assert.ok(edit);
    Object.assign(f, { withPromptGuard: (_config, prompt) => prompt, withSystemPrompt: (_config, prompt) => prompt, applyAgnesImageSize: () => {}, applyImageOutputFormat: () => {}, requestAndParseImages: async (_config, endpoint, body) => ({ endpoint, body }) });
    vm.runInNewContext(compile(edit.getText(imageAst)), f);
    const response = await f.requestAgnesImageEdit({ model: "agnes-image-2.5-flash" }, "edit", [image("local")], { timeoutSeconds: 1 });
    assert.equal(response.endpoint, "/images/generations");
    assert.deepEqual(plain(response.body.extra_body.image), ["data:image/png;base64,fixture"]);
});
