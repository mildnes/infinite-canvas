import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { requestGeneration } from "../services/api/image.ts";
import { defaultConfig } from "../stores/use-config-store.ts";
import { useUserStore } from "../stores/use-user-store.ts";
import { ImageSettingsPanel } from "../components/image-settings-panel.tsx";
import { canvasThemes } from "./canvas-theme.ts";
import * as taskRuns from "./generation-task-run.ts";

const source = readFileSync(new URL("../app/(user)/canvas/[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const syntax = [];
function walk(node) { syntax.push(node); ts.forEachChild(node, walk); }
walk(ast);
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const callback = name => syntax.find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name).initializer.arguments[0].getText(ast);
const definition = name => syntax.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
const pollingEffect = syntax.find(node => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("const pollCanvasTasks =")).arguments[0].getText(ast);
const config = (format = "svg") => ({
    ...defaultConfig, channelMode: "remote", apiMode: "images", model: "gpt-image-2.6-sunburst", imageModel: "gpt-image-2.6-sunburst",
    imageChannelId: "ld", imageOutputFormat: format, count: "1", streamImages: false,
    publicChannels: [{ id: "ld", name: "LD-低价GPT", protocol: "openai", models: ["gpt-image-2.6-sunburst"], imageOutputCapabilities: { "gpt-image-2.6-sunburst": { formats: ["png", "jpeg", "svg"] } } }],
});
const svgURL = `data:image/svg+xml;base64,${Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")}`;
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(format = "svg", type = "image", content) {
    const node = { id: "source", type, title: "原节点", position: { x: 0, y: 0 }, width: 420, height: 236, metadata: { prompt: "人物海报", imageOutputFormat: format, status: "success", content } };
    const state = { nodes: [node], requests: [], polls: [], notices: [], running: null };
    const request = deferred();
    let serial = 0;
    const scope = {
        ...taskRuns, Error, Date, Object, Math, AbortController, DOMException,
        CanvasNodeType: { Image: "image", Panorama: "panorama", Config: "config", Text: "text", Video: "video", Audio: "audio" },
        NODE_STATUS_LOADING: "loading", NODE_STATUS_ERROR: "error", NODE_STATUS_SUCCESS: "success",
        NODE_DEFAULT_SIZE: { image: { width: 420, height: 236 }, panorama: { width: 420, height: 236 }, config: { width: 420, height: 236 } },
        PANORAMA_IMAGE_SIZE: "2:1", PANORAMA_NODE_SIZE: { width: 420, height: 236 },
        nodesRef: { get current() { return state.nodes; } }, connectionsRef: { current: [] },
        canvasGenerationDefaults: config(format), effectiveConfig: config(format), projectId: "project",
        requireCanvasWriter: () => true, canWriteCanvas: () => true, shouldOverwriteCanvasNode: () => false,
        buildGenerationConfig: () => config(format), resolveCanvasImageOutputFormat: value => value,
        isAiConfigReady: () => true, canSubmitCanvasMediaRequest: () => true, openConfigDialog() {},
        buildNodeGenerationContext: () => ({ prompt: "人物海报", referenceImages: [] }),
        hydrateNodeGenerationContext: async context => context, applyCameraPrompt: value => value, buildPanoramaPrompt: value => value,
        findRetrySourceNode: () => null, resolveMetadataReferences: async () => [],
        buildAnglePrompt: () => "角度", buildAngleLabel: () => "角度", IMAGE_MASK_EDIT_PROMPT_PREFIX: "局部编辑：",
        isCanvasImageNodeType: value => ["image", "panorama"].includes(value), isPanoramaNodeType: value => value === "panorama",
        isKIESeedreamLayerDecompositionModel: () => false, nodeSizeFromRatio: () => null,
        fitNodeSize: () => ({ width: 420, height: 236 }), referenceUrl: image => image.storageKey || image.dataUrl,
        nanoid: () => `new-${++serial}`, parseCanvasTaskTime: () => 0,
        setNodes: update => { state.nodes = update(state.nodes); }, setConnections() {}, setSelectedNodeIds() {},
        setSelectedConnectionId() {}, setDialogNodeId() {}, setAngleNodeId() {}, setMaskEditNodeId() {},
        setRunningNodeId: value => { state.running = value; },
        message: { error: text => state.notices.push(text), warning: text => state.notices.push(text) },
        useUserStore: { getState: () => ({ token: "jwt", user: { id: "owner" } }) }, currentCanvasOwnerId: () => "owner",
        nodeTaskRunsRef: { current: new Map() }, taskPollingStateRef: { current: new Map() },
        pollingVideoNodeIdsRef: { current: new Set() }, pollingImageNodeIdsRef: { current: new Set() }, pollingAudioNodeIdsRef: { current: new Set() },
        projectLoaded: true, window: { setInterval: () => 1, clearInterval() {} }, VIDEO_POLL_INTERVAL_MS: 5000,
        submitCanvasImageRequest: async (...args) => { state.requests.push(args); return request.promise; },
        pollCanvasImageTaskStatus: async id => { state.polls.push(id); throw Object.assign(new Error("任务记录不存在"), { status: 404 }); },
        reportNodeTaskPollError: (target, _run, error) => {
            const outcome = taskRuns.recordCanvasTaskPollError(target.metadata.imageTaskId, error);
            state.nodes = state.nodes.map(item => item.id === target.id ? { ...item, metadata: { ...item.metadata, status: "error", taskPollError: true, errorDetails: outcome.errorDetails } } : item);
        },
    };
    vm.createContext(scope);
    vm.runInContext(compile(["getGenerationCount", "buildImageGenerationMetadata", "canvasTaskCompleted", "canvasTaskFailed", "canvasImageTaskURLs", "canvasRecoverableTaskId", "applyCanvasImageTaskUpdate", "applyCanvasImageTaskConnections"].map(definition).join("\n")), scope);
    for (const name of ["startNodeTaskRun", "nodeRunActive", "guardNodeTaskResponse"]) scope[name] = vm.runInContext(compile(`(${callback(name)})`), scope);
    return {
        state, request, scope, node,
        call: name => vm.runInContext(compile(`(${callback(name)})`), scope),
        poll: () => vm.runInContext(compile(`(${pollingEffect})`), scope)()(),
    };
}

test("SVG 400 生成失败保留原文和可操作建议，不误报渠道不支持", async t => {
    const old = useUserStore.getState(), oldWindow = globalThis.window;
    useUserStore.setState({ token: "jwt", user: { id: "owner" }, hydrateUser: async () => {} });
    globalThis.window = { location: { pathname: "/canvas/svg" }, setTimeout, clearTimeout };
    t.after(() => { useUserStore.setState(old); if (oldWindow) globalThis.window = oldWindow; else delete globalThis.window; });
    let upstreamMessage;
    t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: upstreamMessage } }, { status: 400 }));
    for (const [raw, chinese] of [
        ["Upstream did not attach an SVG file", "模型未能产出矢量文件"],
        ["Unsupported SVG element", "生成内容超出矢量格式表达能力"],
        ["Another upstream failure", "Another upstream failure"],
    ]) {
        upstreamMessage = raw;
        await assert.rejects(requestGeneration(config(), "人物海报"), error => {
            assert.ok(!error.message.includes("当前渠道不支持 SVG"), error.message);
            assert.ok(error.message.includes(chinese), error.message);
            assert.ok(error.message.includes(raw), "上游原始 message 不得丢弃");
            assert.ok(error.message.includes("PNG"), "生成失败应提供切换 PNG 的建议");
            assert.ok(error.detail.includes(raw));
            return true;
        });
    }
});

test("守卫：真正不支持 SVG 的 400 保留渠道提示和原文，PNG 的 400 文案不变", async t => {
    const old = useUserStore.getState(), oldWindow = globalThis.window;
    useUserStore.setState({ token: "jwt", user: { id: "owner" }, hydrateUser: async () => {} });
    globalThis.window = { location: { pathname: "/canvas/svg" }, setTimeout, clearTimeout };
    t.after(() => { useUserStore.setState(old); if (oldWindow) globalThis.window = oldWindow; else delete globalThis.window; });
    let raw = "SVG generation requires '***.model'";
    t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: raw } }, { status: 400 }));
    await assert.rejects(requestGeneration(config(), "矢量图"), error => {
        assert.ok(error.message.includes("当前渠道不支持 SVG，请切换到 LD-低价GPT 渠道"));
        assert.ok(error.message.includes(raw));
        return true;
    });
    raw = "PNG 上游原始失败";
    await assert.rejects(requestGeneration(config("png"), "图片"), error => error.message === raw);
});

test("SVG 失败：加载阶段不带假任务 ID，不发轮询；终态保留真实错误", async () => {
    const f = fixture();
    const pending = f.call("handleGenerateNode")(f.node.id, "image", "人物海报");
    await settle();
    const loading = f.state.nodes.find(node => node.id === "source");
    const loadingId = loading.metadata.imageTaskId;
    f.poll();
    await settle();
    f.request.reject(new Error("Upstream did not attach an SVG file"));
    await pending;
    assert.equal(loadingId, undefined, "SVG 加载中也不能留下供轮询的假 imageTaskId");
    assert.deepEqual(f.state.polls, [], "浏览器直连 SVG 不得查询服务端任务");
    assert.equal(f.state.nodes[0].metadata.status, "error");
    assert.equal(f.state.nodes[0].metadata.imageTaskId, undefined);
    assert.ok(f.state.nodes[0].metadata.errorDetails.includes("Upstream did not attach an SVG file"));
    assert.ok(!f.state.nodes[0].metadata.errorDetails.includes("任务记录不存在"));
    assert.equal(f.state.running, null);
});

test("SVG 成功：没有 imageTaskId/resultId 或轮询，保留本机模式与 revisedPrompt", async () => {
    const f = fixture();
    const pending = f.call("handleGenerateNode")(f.node.id, "image", "人物海报");
    await settle();
    f.request.resolve({ id: "browser-only-result", status: "completed", image_url: svgURL, storageKey: "image:svg", mimeType: "image/svg+xml", revisedPrompt: "模型改写" });
    await pending;
    f.poll();
    await settle();
    const metadata = f.state.nodes[0].metadata;
    assert.equal(metadata.status, "success");
    assert.equal(metadata.imageTaskId, undefined, "SVG 成功也不得登记不存在的服务端任务");
    assert.equal(metadata.imageTaskResultId, undefined);
    assert.deepEqual(f.state.polls, []);
    assert.equal(metadata.content, svgURL);
    assert.equal(metadata.mediaStatus, "local-only");
    assert.ok(metadata.mediaError.includes("不支持上云"));
    assert.equal(metadata.revisedPrompt, "模型改写");
    assert.equal(metadata.prompt, "人物海报");
});

for (const entry of ["maskEditImageNode", "generateAngleNode", "panorama", "handleRetryNode"]) {
    test(`SVG ${entry} 入口不遗留服务端任务 ID，失败后可重新生成`, async () => {
        const f = fixture("svg", entry === "panorama" ? "panorama" : "image", entry === "maskEditImageNode" || entry === "generateAngleNode" ? "old-image" : undefined);
        const pending = entry === "panorama"
            ? f.call("handleGenerateNode")(f.node.id, "image", "人物海报")
            : entry === "handleRetryNode"
                ? f.call(entry)(f.node)
                : f.call(entry)(f.node, { prompt: "修改", markedDataUrl: "data:image/png;base64,aA==" });
        await settle();
        const loading = f.state.nodes.filter(node => node.metadata.status === "loading");
        const ids = loading.map(node => node.metadata.imageTaskId);
        assert.ok(loading.length > 0);
        f.request.reject(new Error("SVG 仅支持文生图或本次生成失败"));
        await pending;
        assert.ok(ids.every(id => id === undefined), `${entry} loading IDs: ${JSON.stringify(ids)}`);
        assert.ok(f.state.nodes.filter(node => node.metadata.status === "error").every(node => node.metadata.imageTaskId === undefined));
        assert.equal(f.state.running, null);
    });
}

test("SVG 选项显示适用范围提示，PNG 不出现该提示", () => {
    for (const format of ["svg", "png"]) {
        const html = renderToStaticMarkup(React.createElement(ImageSettingsPanel, { config: config(format), theme: canvasThemes.dark, onConfigChange() {}, showSize: false }));
        assert.equal(html.includes("人物、照片、复杂插画请用 PNG"), format === "svg");
    }
});

test("已有 SVG 孤儿 ID 不进入自动查询、恢复或重试查询分支", async () => {
    const f = fixture();
    f.state.nodes[0].metadata = { ...f.state.nodes[0].metadata, status: "loading", imageTaskId: "legacy-svg-orphan" };
    assert.equal(f.scope.canvasRecoverableTaskId(f.state.nodes[0]), "", "SVG 不是可恢复的服务端任务");
    f.poll();
    await settle();
    assert.deepEqual(f.state.polls, []);
    let batchCalls = 0;
    f.scope.batchCanvasImageTaskStatus = async () => { batchCalls++; return []; };
    const recover = vm.runInContext(compile(`(${definition("recoverPersistedCanvasImageTasks")})`), f.scope);
    await recover(f.state.nodes);
    assert.equal(batchCalls, 0);
});

test("守卫：SVG 成功仍标为本机文件，提示不上云并保留模型改写提示词", async () => {
    const f = fixture();
    const pending = f.call("handleGenerateNode")(f.node.id, "image", "人物海报");
    await settle();
    f.request.resolve({ id: "browser-result", status: "completed", image_url: svgURL, storageKey: "image:svg", mimeType: "image/svg+xml", revisedPrompt: "模型改写" });
    await pending;
    const metadata = f.state.nodes[0].metadata;
    assert.equal(metadata.content, svgURL);
    assert.equal(metadata.storageKey, "image:svg");
    assert.equal(metadata.mediaStatus, "local-only");
    assert.equal(metadata.mediaError, "SVG 已保存在本机，当前文件策略不支持上云");
    assert.equal(metadata.revisedPrompt, "模型改写");
    assert.equal(metadata.prompt, "人物海报");
});

test("守卫：PNG/JPEG/透明 PNG 仍绑定服务端任务并轮询完成，失败原文不变", async () => {
    for (const format of ["png", "jpeg", "png-transparent"]) {
        for (const failed of [false, true]) {
            const f = fixture(format);
            const pending = f.call("handleGenerateNode")(f.node.id, "image", "人物海报");
            await settle();
            const taskId = f.state.nodes[0].metadata.imageTaskId;
            assert.ok(taskId.startsWith("client_image_task_"));
            if (failed) {
                f.request.reject(new Error("PNG 原始失败"));
                await pending;
                assert.equal(f.state.nodes[0].metadata.status, "error");
                assert.equal(f.state.nodes[0].metadata.errorDetails, "PNG 原始失败");
            } else {
                f.request.resolve({ id: taskId, status: "processing", progress: 10 });
                await pending;
                f.scope.pollCanvasImageTaskStatus = async id => {
                    f.state.polls.push(id);
                    return { id, status: "completed", image_url: "/api/files/png/content", storageKey: "server:png", mimeType: "image/png" };
                };
                f.poll();
                await settle();
                assert.deepEqual(f.state.polls, [taskId]);
                assert.equal(f.state.nodes[0].metadata.status, "success");
                assert.equal(f.state.nodes[0].metadata.imageTaskResultId, taskId);
            }
            assert.equal(f.state.nodes[0].metadata.imageTaskId, taskId);
        }
    }
});
