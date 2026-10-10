import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["normalizeChannel", "normalizeModelMap", "normalizeModelCapabilities", "uniqueModels", "uniqueCapabilities", "renameChannelModel", "mergeChannelModelSelection", "resolveAvailableModels", "filterModels", "collectChannelModels", "collectChannelModelMapKeys"]);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(ast)).join("\n");
const context = {
    normalizeImageOutputCapabilities: value => value,
    normalizeImageQualityCapabilities: value => value,
    isWorkflowProtocol: () => false,
    modelCapabilityOptions: [{ value: "image" }, { value: "video" }, { value: "text" }, { value: "audio" }],
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
    assert.ok(source.includes("Object.keys(channelModelMap"), "rows union models with mapping keys");
    assert.ok(source.includes("+ 添加映射"), "editor can add a mapping row for a new local name");
    assert.ok(source.includes("上游真实模型名（留空 = 与本地名同名直传）"), "upstream side explains same-name passthrough");
});

test("拉取上游模型时保留已有自定义本地名及其映射", () => {
    const merged = context.mergeChannelModelSelection(["我的高质图", "plain"], { "我的高质图": "gpt-image-2.5-sunburst" }, ["gpt-image-2", "gpt-image-2-high"]);
    assert.deepEqual(plain(merged), ["我的高质图", "gpt-image-2", "gpt-image-2-high"]);
    assert.deepEqual(plain(context.mergeChannelModelSelection(["plain"], {}, ["gpt-image-2"])), ["gpt-image-2"]);
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
