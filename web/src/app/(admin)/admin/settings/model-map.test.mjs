import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["normalizeChannel", "normalizeModelMap", "uniqueModels"]);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(ast)).join("\n");
const context = { normalizeModelCapabilities: value => value, normalizeImageOutputCapabilities: value => value, normalizeImageQualityCapabilities: value => value };
vm.runInNewContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
const plain = value => JSON.parse(JSON.stringify(value));

test("管理端渠道保存/重开保留本地名、多对一映射与能力，清空上游名恢复透传", () => {
    const input = { models: ["local-a", "local-b", "empty"], modelMap: { "local-a": " upstream ", "local-b": "upstream", empty: " ", removed: "unused" }, modelCapabilities: { "local-a": ["image"] } };
    const saved = context.normalizeChannel(input);
    assert.deepEqual(plain(saved.modelMap), { "local-a": "upstream", "local-b": "upstream" });
    assert.deepEqual(plain(saved.models), input.models);
    assert.deepEqual(plain(saved.modelCapabilities), input.modelCapabilities);
    const reopened = context.normalizeChannel(plain(saved));
    assert.deepEqual(plain(reopened.modelMap), plain(saved.modelMap));
    const cleared = context.normalizeChannel({ ...reopened, modelMap: { "local-a": "", "local-b": " " } });
    assert.equal(cleared.modelMap, undefined);
    assert.equal(context.normalizeChannel({ models: ["local"] }).modelMap, undefined);
    assert.equal(context.normalizeChannel({ models: ["local"], modelMap: { local: 42 } }).modelMap, undefined);
    assert.ok(source.includes('name={["modelMap", model]}'), "editor binds upstream values to local model keys");
});
