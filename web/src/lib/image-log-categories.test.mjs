import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { addCategoryIds, resolveCategoryByName } from "./image-log-categories.ts";

test("分类ID去重且保留先原有后新增的顺序，空输入安全", () => {
    assert.deepEqual(addCategoryIds(["old", "other"], ["other", "new", "new"]), ["old", "other", "new"]);
    assert.deepEqual(addCategoryIds([], []), []);
    assert.deepEqual(addCategoryIds(undefined, undefined), []);
    const original = ["old"];
    assert.deepEqual(addCategoryIds(original, ["new"]), ["old", "new"]);
    assert.deepEqual(original, ["old"]);
});

test("同名分类按去除首尾空格后的名字复用，不创建重复分类", () => {
    const categories = [{ id: "same", name: "已存在" }, { id: "other", name: "另一个" }];
    assert.equal(resolveCategoryByName(categories, " 已存在 "), categories[0]);
    assert.equal(resolveCategoryByName(categories, ""), undefined);
    assert.equal(resolveCategoryByName(categories, "新分类"), undefined);
});

const source = readFileSync(new URL("../app/(user)/image/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("image.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name, scope) {
    let declaration;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(declaration, "missing " + name);
    const code = ts.transpileModule("(" + declaration.initializer.getText(ast) + ")", { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    return vm.runInNewContext(code, scope);
}

test("真实批量回调仅更新选中日志，跳过已有目标分类并保留选择", async () => {
    let logs = [
        { id: "selected-new", categoryIds: ["old"] },
        { id: "selected-existing", categoryIds: ["target"] },
        { id: "unselected", categoryIds: [] },
    ];
    const untouched = logs[2];
    const selectedLogIds = ["selected-new", "selected-existing"];
    const writes = [];
    const persisted = [];
    const run = () => callback("addSelectedLogsToCategory", {
        logs, selectedLogIds, categories: [{ id: "target", name: "目标" }], addCategoryIds,
        setLogs: (value) => { logs = value; },
        logStore: { setItem: async (...args) => { writes.push(args); } },
        serializeLog: (log) => log,
        persistImageHistory: async (...args) => { persisted.push(args); },
        refreshLogs: async () => logs,
    });
    assert.equal(await run()(["target"]), 1);
    assert.deepEqual(Array.from(logs[0].categoryIds), ["old", "target"]);
    assert.deepEqual(Array.from(logs[1].categoryIds), ["target"]);
    assert.equal(logs[2], untouched);
    assert.deepEqual(selectedLogIds, ["selected-new", "selected-existing"]);
    assert.equal(await run()(["target"]), 0);
    assert.equal(writes.length, 1);
    assert.equal(persisted.length, 1);
});

test("批量分类按钮有空选择保护，新建分类复用名称解析", () => {
    assert.match(source, /onAddSelectedToCategory/);
    assert.match(source, /添加至分类/);
    assert.match(source, /目标分类（单选，保留原有分类）/);
    assert.match(source, /resolveCategoryByName\(categories, trimmedName\)/);
});
