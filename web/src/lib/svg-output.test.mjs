import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyImageOutputFormatFields, normalizeBase64Image, requestGeneration, requestEdit } from "../services/api/image.ts";
import { imageOutputCapabilityForConfig } from "./image-output-format.ts";
import { prepareImagePreview } from "./image-preview.ts";
import { defaultConfig } from "../stores/use-config-store.ts";
import { useUserStore } from "../stores/use-user-store.ts";
import { ImageSettingsPanel } from "../components/image-settings-panel.tsx";
import { canvasThemes } from "./canvas-theme.ts";

const svg = '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g"><stop stop-color="#f00"/></linearGradient></defs><path fill="url(#g)" d="M0 0h64v64H0z"/></svg>';
const base64 = Buffer.from(svg).toString("base64");
const dataURL = `data:image/svg+xml;base64,${base64}`;
const downloadSource = readFileSync(new URL("../app/(user)/canvas/utils/canvas-selected-download.ts", import.meta.url), "utf8");
const downloadAST = ts.createSourceFile("download.ts", downloadSource, ts.ScriptTarget.Latest, true);
const downloadScope = {};
vm.runInNewContext(ts.transpileModule(downloadAST.statements.filter(node => ts.isFunctionDeclaration(node) && ["imageExtension", "audioExtension", "canvasNodeDownloadFileName"].includes(node.name?.text)).map(node => node.getText(downloadAST).replace(/^export\s+/, "")).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, downloadScope);
const { imageExtension, canvasNodeDownloadFileName } = downloadScope;
const config = (declaredSVG = true) => ({
    ...defaultConfig, channelMode: "remote", model: "gpt-image-2.6-flare", imageModel: "gpt-image-2.6-flare", imageChannelId: "channel",
    apiMode: "images", imageOutputFormat: "svg", count: "6", streamImages: true, publicChannels: [{
        id: "channel", protocol: "openai", name: declaredSVG ? "LD-低价GPT" : "gpt2.6", models: ["gpt-image-2.6-flare"],
        imageOutputCapabilities: { "gpt-image-2.6-flare": { formats: declaredSVG ? ["png", "jpeg", "svg"] : ["png", "jpeg"] } },
    }],
});

test("SVG 请求强制单张并移除不支持参数；PNG/JPEG/透明 PNG 守卫", () => {
    const actual = applyImageOutputFormatFields({ n: 6, stream: true, partial_images: 3, output_compression: 50, prompt_rewriter: "x", background: "transparent" }, "svg", "openai");
    assert.deepEqual(actual, { n: 1, output_format: "svg" });
    assert.deepEqual(applyImageOutputFormatFields({}, "png-transparent", "openai"), { output_format: "png", background: "transparent" });
    assert.deepEqual(applyImageOutputFormatFields({}, "jpeg", "openai"), { output_format: "jpeg" });
    assert.equal(normalizeBase64Image(base64, "image/svg+xml"), dataURL);
    assert.ok(Buffer.from(base64, "base64").toString().startsWith("<?xml"));
});

test("SVG 数量选择锁定为 1 并说明原因，rolldek 声明不含 SVG 时无选项", () => {
    const selected = config();
    assert.ok(imageOutputCapabilityForConfig(selected).formats.includes("svg"));
    const html = renderToStaticMarkup(React.createElement(ImageSettingsPanel, { config: selected, theme: canvasThemes.dark, onConfigChange() {}, showSize: false }));
    assert.ok(html.includes("SVG（矢量）"));
    assert.ok(/<fieldset[^>]*disabled/.test(html), "全部数量选择必须禁用");
    assert.ok(html.includes("SVG 仅支持 1 张"));
    const unsupported = config(false);
    assert.ok(!imageOutputCapabilityForConfig(unsupported).formats.includes("svg"));
    const hidden = renderToStaticMarkup(React.createElement(ImageSettingsPanel, { config: unsupported, theme: canvasThemes.dark, onConfigChange() {}, showSize: false }));
    assert.ok(!hidden.includes("SVG（矢量）"));
});

test("SVG 下载沿用节点唯一命名并使用 .svg 扩展名", () => {
    assert.equal(imageExtension(dataURL, "image/svg+xml"), "svg");
    assert.equal(canvasNodeDownloadFileName({ id: "svg-node", type: "image", metadata: { content: dataURL, mimeType: "image/svg+xml" } }), "canvas-image-svg-node.svg");
});

test("SVG 预览不触发 createImageBitmap 或 Canvas 光栅化", async t => {
    const oldDocument = globalThis.document, oldBitmap = globalThis.createImageBitmap;
    let decoded = 0;
    globalThis.document = {};
    globalThis.createImageBitmap = async () => { decoded++; throw new Error("SVG must not use bitmap decoder"); };
    t.after(() => { globalThis.document = oldDocument; globalThis.createImageBitmap = oldBitmap; });
    assert.equal(await prepareImagePreview(new Blob([svg], { type: "image/svg+xml" })), null);
    assert.equal(decoded, 0);
});

test("SVG 仅走 generations；真实失败提示渠道不支持，不改为 PNG 重试", async t => {
    const old = useUserStore.getState(), oldWindow = globalThis.window;
    useUserStore.setState({ token: "owner", user: { id: "owner" }, hydrateUser: async () => {} });
    globalThis.window = { location: { pathname: "/canvas/svg" }, setTimeout, clearTimeout };
    t.after(() => { useUserStore.setState(old); if (oldWindow) globalThis.window = oldWindow; else Reflect.deleteProperty(globalThis, "window"); });
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return Response.json({ error: { message: "SVG generation requires another model" } }, { status: 400 });
    });
    await assert.rejects(requestGeneration(config(), "矢量图"), /当前渠道不支持 SVG/);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.endsWith("/images/generations"));
    assert.equal(requests[0].body.output_format, "svg");
    assert.equal(requests[0].body.n, 1);
    assert.equal(requests[0].body.stream, undefined);
    requests.length = 0;
    await assert.rejects(requestEdit(config(), "修改", [{ id: "ref", dataUrl: "data:image/png;base64,aA==", name: "ref.png", type: "image/png" }]), /SVG.*文生图/);
    assert.equal(requests.length, 0);
});

test("本地 SVG 缓存恢复原 data URL，跳过位图尺寸与服务端上传", async () => {
    const source = readFileSync(new URL("../services/image-storage.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("storage.ts", source, ts.ScriptTarget.Latest, true);
    const names = ["uploadImage", "resolveLocalImageUrl"];
    const code = ts.transpileModule(ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast).replace(/^export\s+/, "")).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const disk = new Map(), urls = new Map();
    let probes = 0, uploads = 0;
    const scope = {
        store: { setItem: async (key, value) => disk.set(key, value), getItem: async key => disk.get(key) },
        objectUrls: urls, nanoid: () => "svg-cache", getProxyUrl: url => url,
        fetch: async () => new Response(new Blob([svg], { type: "image/svg+xml" })),
        blobToDataUrl: async () => dataURL, readImageMeta: async () => { probes++; return { width: 64, height: 64 }; },
        maybeUploadImageToServer: async () => { uploads++; return null; }, URL, Blob,
    };
    vm.createContext(scope); vm.runInContext(code, scope);
    const stored = await scope.uploadImage(dataURL, { localOnly: true });
    assert.equal(stored.url, dataURL);
    assert.equal(stored.storageKey, "image:svg-cache");
    assert.equal(stored.mimeType, "image/svg+xml");
    urls.clear();
    assert.equal(await scope.resolveLocalImageUrl(stored.storageKey), dataURL);
    assert.equal(probes, 0);
    assert.equal(uploads, 0);
    assert.equal(await disk.get(stored.storageKey).text(), svg);
});

test("真实响应解析保留 SVG 原字节；画板 SVG 任务走单张响应且不创建服务端图片任务", async () => {
    const source = readFileSync(new URL("../services/api/image.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("image.ts", source, ts.ScriptTarget.Latest, true);
    const names = ["parseImagePayload", "resolveImageDataUrl", "getStringRecordValue", "createCanvasImageTask", "syncGeneratedImages"];
    const code = ts.transpileModule(ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast).replace(/^export\s+/, "")).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    let generationCalls = 0;
    const scope = {
        normalizeBase64Image, nanoid: () => "svg-result", ImageRequestError: Error,
        useUserStore: { getState: () => ({ token: "owner" }) },
        usesAccountProxy: () => true, captureImageRequestOwner: () => ({ token: "owner" }),
        createImageRequestParams: () => ({ n: 1 }), createCanvasImageTaskRequest: async () => ({ method: "POST", body: "{}" }),
        requestImages: async () => {
            generationCalls++;
            return scope.parseImagePayload({ data: [{ b64_json: base64 }] }, "image/svg+xml");
        },
        autoSyncImage: async content => ({ url: content, storageKey: "image:svg-result", mimeType: "image/svg+xml", bytes: Buffer.byteLength(svg), width: 0, height: 0 }),
        fetch: async () => { throw new Error("SVG 不应提交到服务端图片任务或文件接口"); },
    };
    vm.createContext(scope); vm.runInContext(code, scope);
    const task = await scope.createCanvasImageTask(config(), "矢量图", [], { nodeId: "node", clientTaskId: "svg-task" });
    assert.equal(generationCalls, 1);
    assert.equal(task.status, "completed");
    assert.equal(task.storageKey, "image:svg-result");
    assert.equal(task.mimeType, "image/svg+xml");
    assert.equal(task.image_url, dataURL);
    assert.equal(Buffer.from(task.image_url.split(",")[1], "base64").toString(), svg);
});
