import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { defaultConfig, resolveModelForCapability } from "./use-config-store.ts";

const source = readFileSync(new URL("./use-config-store.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("store.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(["resolveEffectiveConfig", "validDefault", "preferredModel"]);
const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text)).map(n => n.getText(ast)).join("\n");
const context = {
    normalizeLocalChannels: config => config.localChannels || [],
    isWorkflowProtocol: () => false,
    normalizeModelList: values => [...new Set(values)],
    filterChannelModelsByCapability: (channels, capability, allowed) => channels.flatMap(channel => (channel.models || []).filter(model => channel.modelCapabilities?.[model]?.includes(capability) && allowed.includes(model))),
    isTextModelName: () => true, isImageModelName: () => true, isVideoModelName: () => true, isAudioModelName: () => true,
};
vm.runInNewContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
const plain = value => JSON.parse(JSON.stringify(value));

test("remote 设置加载期间不借用本地模型，系统列表与选择均为空", () => {
    const config = { ...defaultConfig, channelMode: "remote", localChannels: [{ models: ["local-secret"] }] };
    const resolved = context.resolveEffectiveConfig(config, null, true);
    assert.deepEqual(plain(resolved.models), []);
    for (const key of ["model", "imageModel", "videoModel", "textModel", "audioModel"]) assert.equal(resolved[key], "");
});

test("受限列表收缩时模型回落可见候选，无能力候选时保持空", () => {
    const settings = { availableModels: ["text-only"], channels: [{ models: ["text-only"], modelCapabilities: { "text-only": ["text"] } }] };
    const resolved = context.resolveEffectiveConfig(defaultConfig, settings, true);
    assert.deepEqual(plain(resolved.models), ["text-only"]);
    assert.equal(resolved.textModel, "text-only");
    for (const capability of ["image", "video", "audio"]) {
        assert.equal(resolveModelForCapability({ ...resolved, channelMode: "remote" }, "gpt-image-old", capability), "");
    }
});

test("本地直连不受组限制，原有模型与兜底保持", () => {
    const config = { ...defaultConfig, channelMode: "local", channelModeManuallySelected: true, localChannels: [{ models: ["local-image"] }] };
    const resolved = context.resolveEffectiveConfig(config, { allowCustomChannel: true }, true);
    assert.deepEqual(plain(resolved.models), ["local-image"]);
    assert.equal(resolveModelForCapability({ ...config, models: [], publicChannels: [], localChannels: [] }, "gpt-image-old", "image"), "gpt-image-old");
});

test("工作流历史图片模型不可见且仅有文本候选时，不把文本模型当图片默认", () => {
    const workflowSource = readFileSync(new URL("../components/workflows/creative-workflow-workspace.tsx", import.meta.url), "utf8");
    const workflowAst = ts.createSourceFile("workflow.tsx", workflowSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const helpers = new Set(["resolveWorkflowRuntime", "resolveWorkflowImageChannelId", "createWorkflowConfig", "createWorkflowSeriesConfig"]);
    const code = workflowAst.statements.filter(n => ts.isFunctionDeclaration(n) && helpers.has(n.name?.text)).map(n => n.getText(workflowAst)).join("\n");
    const runtime = { defaultConfig, resolveModelForCapability, normalizeLocalChannels: config => config.localChannels || [] };
    vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, runtime);
    const restricted = { ...defaultConfig, channelMode: "remote", model: "text-only", textModel: "text-only", imageModel: "", models: ["text-only"], publicChannels: [{ id: "text", protocol: "openai", models: ["text-only"], modelCapabilities: { "text-only": ["text"] } }] };
    assert.equal(runtime.resolveWorkflowRuntime({ config: { imageModel: "gpt-image-old" } }, restricted).model, "");
    assert.equal(runtime.createWorkflowConfig(restricted).imageModel, "");
    assert.equal(runtime.createWorkflowSeriesConfig({ ...restricted, model: "", textModel: "", models: [], publicChannels: [] }).promptModel, "");
    assert.equal(runtime.resolveWorkflowRuntime({ config: { imageModel: "custom-local" } }, { ...restricted, channelMode: "local" }).model, "custom-local");
});
