import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { appendUpstreamModelRows, deriveModelMapping } from "./model-mapping-editor.tsx";
import { normalizeImageOutputCapabilities } from "./image-output-capabilities.ts";
import { normalizeImageQualityCapabilities } from "./image-quality-capabilities.ts";

const source = readFileSync(process.env.MODEL_MAPPING_PAGE_SOURCE || new URL("./page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["normalizeChannel", "normalizeModelMap", "normalizeModelCapabilities", "uniqueModels", "uniqueCapabilities", "renameChannelModel", "applyModelMappingRows", "mergeChannelModelSelection", "resolveAvailableModels", "filterModels", "collectChannelModels", "collectChannelModelMapKeys", "collectSettings"]);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(ast)).join("\n");
const context = {
    normalizeImageOutputCapabilities,
    normalizeImageQualityCapabilities,
    isWorkflowProtocol: () => false,
    modelCapabilityOptions: [{ value: "image" }, { value: "video" }, { value: "text" }, { value: "audio" }],
    deriveModelMapping,
    normalizeSettings: value => value,
    collectChannelWorkflows: () => [],
};
vm.runInNewContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
const plain = value => JSON.parse(JSON.stringify(value));

test("管理端渠道保存/重开保留本地名、多对一映射与能力，且自定义映射键并入 models", () => {
    const input = { models: ["local-a", "local-b", "empty"], modelMap: { "local-a": " upstream ", "local-b": "upstream", empty: " ", removed: "unused" }, modelCapabilities: { "local-a": ["image"] } };
    const saved = context.normalizeChannel(input);
    assert.deepEqual(plain(saved.modelMap), { "local-a": "upstream", "local-b": "upstream", removed: "unused" });
    assert.deepEqual(plain(saved.models), ["local-a", "local-b", "empty", "removed"]);
    assert.deepEqual(plain(saved.modelCapabilities), input.modelCapabilities);
    const reopened = context.normalizeChannel(plain(saved));
    assert.deepEqual(plain(reopened.modelMap), plain(saved.modelMap));
    const cleared = context.normalizeChannel({ ...reopened, modelMap: { "local-a": "", "local-b": " " } });
    assert.equal(cleared.modelMap, undefined);
    assert.equal(context.normalizeChannel({ models: ["local"] }).modelMap, undefined);
    assert.equal(context.normalizeChannel({ models: ["local"], modelMap: { local: 42 } }).modelMap, undefined);
});

test("改名原子迁移四张声明表，旧名不再出现在 models", () => {
    const channel = {
        models: ["local-a", "local-b"],
        modelMap: { "local-a": "upstream-a" },
        modelCapabilities: { "local-a": ["image"] },
        imageQualityCapabilities: { "local-a": { values: ["high"] } },
        imageOutputCapabilities: { "local-a": { formats: ["png"] } },
    };
    const renamed = context.renameChannelModel(channel, "local-a", "我的高质图");
    assert.deepEqual(plain(renamed.models), ["我的高质图", "local-b"]);
    assert.deepEqual(plain(renamed.modelMap), { "我的高质图": "upstream-a" });
    assert.deepEqual(plain(renamed.modelCapabilities), { "我的高质图": ["image"] });
    assert.deepEqual(plain(renamed.imageQualityCapabilities), { "我的高质图": { values: ["high"] } });
    assert.deepEqual(plain(renamed.imageOutputCapabilities), { "我的高质图": { formats: ["png"] } });
    assert.equal(renamed.modelMap["local-a"], undefined);
    assert.equal(context.renameChannelModel(channel, "local-a", "  ").models[0], "local-a");
});

test("模型映射行使用 models 与 modelMap 的并集，并可追加自定义行", () => {
    assert.ok(source.includes("buildModelMappingRows(channel"), "rows start with saved mappings and models");
    assert.ok(source.includes("ModelMappingEditor"), "editor uses the request/upstream mapping table");
    assert.ok(source.includes("upstreamModels"), "page passes upstream candidates to the editor");
});

test("真实拉取确认回调：已有自定义行不变，上游新模型追加右列而非预填左列", () => {
    let callback;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "confirmChannelModelSelector") callback = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
    }
    visit(ast);
    const initial = [{ id: 1, requestName: "我的高质图", upstreamName: "gpt-image-2.5-sunburst" }];
    let result = initial;
    const runtime = {
        ...context, modelMappingRows: initial, appendUpstreamModelRows,
        rawSelectedChannelModels: ["我的高质图"], channelModelMap: { "我的高质图": "gpt-image-2.5-sunburst" },
        setModelMappingRows: rows => { result = rows; }, commitModelMappingRows: () => {},
        setChannelUpstreamModels: () => {}, rememberModels: () => {}, closeChannelModelSelector: () => {},
        channelForm: { setFieldValue: () => {} }, message: { info: () => {} },
    };
    vm.runInNewContext(ts.transpileModule('const confirm = ' + callback + '; confirm(["gpt-image-2.5-sunburst", "gpt-image-2-high"]);', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, runtime);
    assert.deepEqual(plain(result).map(({ requestName, upstreamName }) => [requestName, upstreamName]), [["我的高质图", "gpt-image-2.5-sunburst"], ["", "gpt-image-2-high"]]);
});

test("保存时自定义本地名并入公开可选模型", () => {
    const channel = { protocol: "openai", enabled: true, baseUrl: "https://example.invalid", models: ["gpt-image-2", "我的高质图"], modelMap: { "我的高质图": "gpt-image-2.5-sunburst" } };
    assert.deepEqual(plain(context.resolveAvailableModels(["gpt-image-2"], [channel], ["我的高质图"])), ["gpt-image-2", "我的高质图"]);
    assert.deepEqual(plain(context.resolveAvailableModels(["gpt-image-2", "gone"], [channel], ["我的高质图"])), ["gpt-image-2", "我的高质图"]);
});

test("管理员取消勾选已保存映射别名后，保存不会自动加回", () => {
    const channel = { protocol: "openai", enabled: true, models: ["gpt-image-2", "我的高质图"], modelMap: { "我的高质图": "gpt-image-2.5-sunburst" } };
    assert.deepEqual(plain(context.resolveAvailableModels(["gpt-image-2"], [channel], [])), ["gpt-image-2"]);
});

test("真实表格提交：请求名改名迁移四表，删除后不合并回旧键", () => {
    const channel = { models: ["old"], modelMap: { old: "upstream" }, modelCapabilities: { old: ["image"] }, imageQualityCapabilities: { old: { values: ["high"] } }, imageOutputCapabilities: { old: { formats: ["png"] } } };
    const previous = [{ id: 1, requestName: "old", upstreamName: "upstream" }];
    const next = context.applyModelMappingRows(channel, [{ ...previous[0], requestName: "new" }], previous);
    assert.deepEqual(plain(next.models), ["new"]);
    for (const key of ["modelMap", "modelCapabilities", "imageQualityCapabilities", "imageOutputCapabilities"]) {
        assert.equal(next[key].old, undefined);
        assert.deepEqual(plain(next[key].new), channel[key].old);
    }
    const deleted = context.applyModelMappingRows(next, [], [{ ...previous[0], requestName: "new" }]);
    assert.deepEqual(plain(deleted.models), []);
    assert.equal(deleted.modelMap, undefined);
    assert.equal(deleted.modelCapabilities, undefined);
    assert.equal(deleted.imageQualityCapabilities, undefined);
    assert.equal(deleted.imageOutputCapabilities, undefined);
});

test("真实总设置保存：新请求名含同名直传自动可选，已保存未勾选名字不自动加回", async () => {
    const channels = [{ protocol: "openai", models: ["existing", "new-direct", "new-alias"], modelMap: { "new-alias": "upstream" } }];
    const input = { private: { channels }, public: { modelChannel: { availableModels: [], availableWorkflows: [], systemPrompts: {} } } };
    const values = await context.collectSettings({ getFieldsValue: () => input }, { public: "visual", private: "visual" }, {}, {}, ["existing"]);
    assert.deepEqual(plain(values.public.modelChannel.availableModels), ["new-direct", "new-alias"]);
    const second = await context.collectSettings({ getFieldsValue: () => ({ ...input, public: { modelChannel: { ...input.public.modelChannel, availableModels: [] } } }) }, { public: "visual", private: "visual" }, {}, {}, ["existing", "new-direct", "new-alias"]);
    assert.deepEqual(plain(second.public.modelChannel.availableModels), []);
});

test("真实渠道保存回调：四行混合推导请求名，删除行保存后不再暴露", async () => {
    let callback;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "saveChannel") callback = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
    }
    visit(ast);
    const rows = [
        { id: 1, requestName: "自定义一", upstreamName: "upstream-a" },
        { id: 2, requestName: "自定义二", upstreamName: "upstream-b" },
        { id: 3, requestName: "", upstreamName: "upstream-c" },
        { id: 4, requestName: "", upstreamName: "upstream-d" },
    ];
    let saved;
    const runtime = {
        ...context, modelMappingRows: rows, commitModelMappingRows: () => {},
        channelForm: { validateFields: async () => ({ protocol: "openai" }), getFieldsValue: () => ({ models: ["stale"], modelMap: { stale: "old-upstream" } }) },
        isWorkflowProtocol: () => false, workflowChannelDraft: {}, editingChannelIndex: null, channels: [],
        rememberModels: () => {}, closeChannelDrawer: () => {}, persistChannels: async value => { saved = value; },
    };
    const run = vm.runInNewContext(ts.transpileModule('const save = ' + callback + '; save;', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, runtime);
    await run();
    assert.deepEqual(plain(saved[0].models), ["自定义一", "自定义二", "upstream-c", "upstream-d"]);
    assert.deepEqual(plain(saved[0].modelMap), { "自定义一": "upstream-a", "自定义二": "upstream-b" });
    runtime.modelMappingRows = rows.slice(1);
    await run();
    assert.deepEqual(plain(saved[0].models), ["自定义二", "upstream-c", "upstream-d"]);
    assert.equal(saved[0].modelMap["自定义一"], undefined);
});
