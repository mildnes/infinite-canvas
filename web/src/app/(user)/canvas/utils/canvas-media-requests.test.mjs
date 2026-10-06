import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { stripReferenceMetadata } from "./prompt-reference-metadata.ts";
import { buildNodeGenerationContext, buildNodeChatMessages } from "../components/canvas-node-generation.ts";
import { CanvasNodeType } from "../types.ts";

const page = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("canvas.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function walk(node) { nodes.push(node); ts.forEachChild(node, walk); }
walk(ast);
const calls = (name) => nodes.filter((node) => ts.isCallExpression(node) && node.expression.getText(ast) === name);
const callback = (name) => nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === name).initializer.arguments[0].getText(ast);
const compile = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;

function harness() {
    const sent = [];
    const source = readFileSync(new URL("./canvas-media-requests.ts", import.meta.url), "utf8");
    const module = ts.createSourceFile("requests.ts", source, ts.ScriptTarget.Latest, true);
    const scope = {
        exports: {}, stripReferenceMetadata, Error,
        createCanvasImageTask: async (...args) => { sent.push(args); return { id: "task", status: "processing" }; },
        createVideoGenerationTask: async (...args) => { sent.push(args); return { task: { id: "task", status: "processing" } }; },
    };
    vm.runInNewContext(compile(module.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node.getText(module)).join("\n")), scope);
    return { ...scope.exports, sent };
}

const dirty = "图片1（用户图片114，左侧 Logo，场景(终版).png）保持不变。";
const clean = "图片1（左侧 Logo）保持不变。";
const empty = "（用户图片114，场景.png）";
const config = { quality: "max", size: "16:9", imageOutputFormat: "png", videoMultiPrompt: [{ prompt: dirty }], videoElementList: [{ description: dirty }] };
const references = [{ id: "right", dataUrl: "https://example.com/right.png" }, { id: "left", dataUrl: "https://example.com/left.png" }];

test("画布提交点穷尽：五处图片、两处视频，不直接调用共享生成 API", () => {
    assert.equal(calls("submitCanvasImageRequest").length, 5);
    assert.equal(calls("submitCanvasVideoRequest").length, 2);
    assert.equal(calls("createCanvasImageTask").length, 0);
    assert.equal(calls("createVideoGenerationTask").length, 0);
});

for (const [index, name] of ["局部编辑 child", "角度图片编辑 child", "全景新生成", "普通／多图生成", "图片／全景历史重试"].entries()) {
    test(`请求 mock：图片 ${index + 1} ${name} 清洗最终副本且保留其他参数`, async () => {
        const api = harness();
        const scope = {
            ...api, generationConfig: config, panoramaGenerationConfig: config,
            prompt: dirty, requestPrompt: dirty, panoramaPrompt: dirty,
            markedReference: references[0], referenceImages: references, retryImages: references, useReferenceImages: true,
            childId: "child", targetId: "child", projectId: "canvas", clientTaskId: "client", targetTaskIds: { child: "client" }, retryImageTaskId: "client", node: { id: "child" }, isPanorama: false,
        };
        await vm.runInNewContext(compile(calls("submitCanvasImageRequest")[index].getText(ast)), scope);
        assert.equal(api.sent[0][1], clean);
        assert.equal(api.sent[0][0].quality, "max");
        assert.equal(api.sent[0][0].imageOutputFormat, "png");
        assert.equal(scope.prompt, dirty);
        assert.equal(scope.panoramaPrompt, dirty);
        assert.deepEqual(Array.from(api.sent[0][2]), index === 0 ? [references[0]] : references);
        assert.equal(api.sent[0][3].clientTaskId, "client");
    });
}

for (const [index, name] of ["普通生成", "历史重试"].entries()) {
    test(`请求 mock：视频 ${index + 1} ${name} 只清 prompt，不清 multi_prompt／element_list`, async () => {
        const api = harness();
        await vm.runInNewContext(compile(calls("submitCanvasVideoRequest")[index].getText(ast)), {
            ...api, videoGenerationConfig: config, requestPrompt: dirty, videoReferenceImages: references, references,
            firstFrame: null, lastFrame: null, generationContext: { referenceVideos: [], referenceAudios: [] }, context: null,
            clientTaskId: "client", retryVideoTaskId: "client", videoId: "child", node: { id: "child" },
        });
        assert.equal(api.sent[0][1], clean);
        assert.equal(api.sent[0][0], config);
        assert.equal(config.videoMultiPrompt[0].prompt, dirty);
        assert.equal(config.videoElementList[0].description, dirty);
        assert.deepEqual(api.sent[0][2].references, references);
    });
}

for (const mode of ["image", "video", "audio"]) {
    test(`工作流 ${mode}：图片／视频清洗，音频保留原文，允许空提示词`, async () => {
        const api = harness();
        const sent = [];
        const definition = nodes.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "submitCanvasWorkflowTask");
        const submit = vm.runInNewContext(compile(`(${definition.getText(ast)})`), {
            ...api, useUserStore: { getState: () => ({ token: "test" }) },
            imageOutputCapabilityForConfig: () => null,
            workflowMediaSource: async (url) => url,
            submitWorkflowTask: async (token, payload) => { sent.push(payload); return payload; },
        });
        await submit({ channelId: "channel", workflowId: "workflow" }, config, mode, dirty, references, [], [], "node", "canvas", "client");
        assert.equal(sent[0].prompt, mode === "audio" ? dirty : clean);
        assert.deepEqual(Array.from(sent[0].referenceImages), references.map((ref) => ref.dataUrl));
        await submit({}, config, mode, empty, [], [], [], "node", "canvas", "client");
        assert.equal(sent[1].prompt, mode === "audio" ? empty : "");
    });
}

test("普通图片／视频清洗后为空，API mock 零调用；工作流和音频豁免", async () => {
    const api = harness();
    await assert.rejects(api.submitCanvasImageRequest(config, empty, []), /提示词为空/);
    await assert.rejects(api.submitCanvasVideoRequest(config, empty, {}), /提示词为空/);
    assert.equal(api.sent.length, 0);
    assert.equal(api.canvasMediaRequestPrompt("image", empty, true), "");
    assert.equal(api.canvasMediaRequestPrompt("audio", empty), empty);
});

function callbackScope(node) {
    const api = harness();
    const state = { nodes: [node], writes: 0, notices: [], running: [] };
    const scope = {
        ...api, Error, CanvasNodeType, nodesRef: { current: state.nodes }, connectionsRef: { current: [] }, effectiveConfig: config,
        useUserStore: { getState: () => ({ token: "test" }) },
        isCanvasImageNodeType: (type) => ["image", "panorama"].includes(type), isPanoramaNodeType: (type) => type === "panorama",
        buildGenerationConfig: () => config, resolveCanvasImageOutputFormat: (value) => value, isAiConfigReady: () => true,
        findRetrySourceNode: () => null, applyCameraPrompt: (value) => value, PANORAMA_IMAGE_SIZE: "2:1",
        buildNodeGenerationContext: () => ({ prompt: node.metadata.prompt, referenceImages: [] }), hydrateNodeGenerationContext: async (context) => context,
        message: { error: (value) => state.notices.push(value), warning: (value) => state.notices.push(value) },
        setRunningNodeId: (value) => state.running.push(value), setNodes: (updater) => { state.writes++; state.nodes = updater(state.nodes); },
        setConnections: () => {}, resolveMetadataReferences: async () => references, nanoid: () => "new", projectId: "canvas",
        NODE_STATUS_LOADING: "loading", NODE_STATUS_ERROR: "error", parseCanvasTaskTime: () => 0,
        NODE_DEFAULT_SIZE: { image: { width: 320, height: 180 } }, buildImageGenerationMetadata: () => ({}),
        buildAnglePrompt: () => empty, buildAngleLabel: () => "angle",
    };
    scope.canSubmitCanvasMediaRequest = vm.runInNewContext(compile(`(${callback("canSubmitCanvasMediaRequest")})`), scope);
    return { api, state, scope };
}

for (const name of ["maskEditImageNode", "generateAngleNode"]) {
    test(`空值预检 ${name}：两条 child 入口均在创建／loading 前拒绝`, async () => {
        const node = { id: "node", type: "image", metadata: { content: "source", prompt: empty } };
        const { state, scope, api } = callbackScope(node);
        scope.canSubmitCanvasMediaRequest = () => false;
        await vm.runInNewContext(compile(`(${callback(name)})`), scope)(node, { prompt: empty });
        assert.equal(state.writes, 0);
        assert.deepEqual(state.running, []);
        assert.equal(api.sent.length, 0);
    });
}

for (const mode of ["image", "video"]) {
    test(`空值预检 handleGenerateNode ${mode}：不写 loading，不遗留假任务`, async () => {
        const node = { id: "node", type: mode, metadata: { prompt: empty, status: "success", content: "original" } };
        const { state, scope, api } = callbackScope(node);
        await vm.runInNewContext(compile(`(${callback("handleGenerateNode")})`), scope)(node.id, mode, empty);
        assert.equal(state.writes, 0);
        assert.deepEqual(state.running, [node.id, null]);
        assert.equal(state.nodes[0].metadata.content, "original");
        assert.equal(api.sent.length, 0);
        assert.match(state.notices[0], /提示词为空/);
    });
}

test("历史图片重试清洗后为空，在清空 content／写 loading 前拒绝", async () => {
    const node = { id: "node", type: "image", metadata: { generationType: "generation", prompt: empty, content: "original", storageKey: "server:existing", status: "success" } };
    const { state, scope, api } = callbackScope(node);
    await vm.runInNewContext(compile(`(${callback("handleRetryNode")})`), scope)(node);
    assert.equal(state.writes, 0);
    assert.equal(state.nodes[0].metadata.content, "original");
    assert.equal(state.nodes[0].metadata.storageKey, "server:existing");
    assert.equal(api.sent.length, 0);
});

for (const type of ["image", "panorama"]) {
    test(`历史 ${type} 重试：清洗提交副本，不改存储 prompt／panoramaFinalPrompt`, async () => {
        const node = { id: "node", type, width: 320, height: 180, metadata: { generationType: "edit", prompt: dirty, panoramaSourcePrompt: dirty, panoramaFinalPrompt: dirty } };
        const { state, scope, api } = callbackScope(node);
        await vm.runInNewContext(compile(`(${callback("handleRetryNode")})`), scope)(node);
        assert.equal(api.sent[0][1], clean);
        assert.equal(state.nodes[0].metadata.prompt, dirty);
        assert.equal(state.nodes[0].metadata.panoramaFinalPrompt, dirty);
        assert.notEqual(state.nodes[0].metadata.status, "error");
    });
}

test("文字修改／问答／音频 context 保留原文；媒体请求清洗上游与组装文本副本", () => {
    const source = { id: "text", type: "text", title: "text", metadata: { content: dirty } };
    const target = { id: "target", type: "config", metadata: {} };
    const connections = [{ id: "edge", fromNodeId: source.id, toNodeId: target.id }];
    const context = buildNodeGenerationContext(target.id, [source, target], connections, dirty);
    assert.ok(context.prompt.includes(dirty));
    assert.ok(buildNodeChatMessages(context).some((message) => JSON.stringify(message).includes(dirty)));
    const api = harness();
    assert.equal(api.canvasMediaRequestPrompt("audio", context.prompt), context.prompt);
    assert.ok(!api.canvasMediaRequestPrompt("image", context.prompt).includes("用户图片"));
    target.metadata.composerContent = "使用 @[node:text]";
    const composed = buildNodeGenerationContext(target.id, [source, target], connections, target.metadata.composerContent);
    assert.ok(composed.prompt.includes("【文本1】"));
    assert.ok(composed.prompt.includes(dirty));
    assert.ok(!api.canvasMediaRequestPrompt("video", composed.prompt).includes("用户图片"));
    assert.equal(source.metadata.content, dirty);
    assert.equal(target.metadata.composerContent, "使用 @[node:text]");
});

for (const index of [0, 1]) {
    test(`请求 mock：音频 ${index ? "重试" : "朗读生成"} 保留原文`, async () => {
        const sent = [];
        await vm.runInNewContext(compile(calls("createCanvasAudioTask")[index].getText(ast)), {
            createCanvasAudioTask: async (...args) => { sent.push(args); },
            generationConfig: config, effectivePrompt: dirty, prompt: dirty,
            audioId: "node", node: { id: "node" }, projectId: "canvas", clientAudioTaskId: "client", retryAudioTaskId: "client", referenceAudio: undefined,
        });
        assert.equal(sent[0][1], dirty);
    });
    test(`请求 mock：requestImageQuestion ${index ? "文字重试" : "文字修改／问答"} 保留原文`, async () => {
        const sent = [];
        const context = { prompt: dirty, referenceImages: [], referenceVideos: [], referenceAudios: [], firstFrame: null, lastFrame: null };
        await vm.runInNewContext(compile(calls("requestImageQuestion")[index].getText(ast)), {
            requestImageQuestion: async (...args) => { sent.push(args); }, buildNodeChatMessages,
            generationConfig: config, generationContext: context, context, effectivePrompt: dirty, prompt: dirty,
        });
        assert.ok(JSON.stringify(sent[0][1]).includes(dirty));
    });
}

test("Agent 生成经 handleGenerateNode 复用画布提交边界", async () => {
    const sent = [];
    const agentCalls = calls("handleGenerateNode").filter((node) => node.getText(ast) === "handleGenerateNode(node.id, mode, prompt)");
    assert.equal(agentCalls.length, 1);
    await vm.runInNewContext(compile(agentCalls[0].getText(ast)), {
        handleGenerateNode: async (...args) => { sent.push(args); }, node: { id: "agent" }, mode: "image", prompt: dirty,
    });
    assert.deepEqual(Array.from(sent[0]), ["agent", "image", dirty]);
});
