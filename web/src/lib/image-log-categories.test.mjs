import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { addCategoryIds, resolveCategoryByName } from "./image-log-categories.ts";

const helperSource = readFileSync(new URL("./image-log-categories.ts", import.meta.url), "utf8");
const helperModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(helperSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: helperModule.exports, module: helperModule });
function mergeCategories(...args) {
    assert.equal(typeof helperModule.exports.mergeImageCategories, "function", "mergeImageCategories must be exported");
    return JSON.parse(JSON.stringify(helperModule.exports.mergeImageCategories(...args)));
}

test("分类同步合并本地与远端并集，输入不被修改", () => {
    const local = [{ id: "a", name: "本地", createdAt: 1 }];
    const remote = [{ id: "b", name: "远端", createdAt: 2 }];
    assert.deepEqual(mergeCategories(local, remote, [], []), {
        categories: [...local, ...remote], deletedCategories: [],
    });
    assert.deepEqual(local, [{ id: "a", name: "本地", createdAt: 1 }]);
    assert.deepEqual(remote, [{ id: "b", name: "远端", createdAt: 2 }]);
});

test("同 ID 分类以 updatedAt 较新者为准，缺失时回退 createdAt", () => {
    const result = mergeCategories([
        { id: "updated", name: "本地新名", createdAt: 1, updatedAt: 5 },
        { id: "legacy", name: "本地旧名", createdAt: 2 },
        { id: "fallback", name: "本地旧名", createdAt: 3, updatedAt: 4 },
    ], [
        { id: "updated", name: "远端旧名", createdAt: 1, updatedAt: 4 },
        { id: "legacy", name: "远端新名", createdAt: 6 },
        { id: "fallback", name: "远端新名", createdAt: 7 },
    ], [], []);
    assert.deepEqual(result.categories.map(({ id, name }) => [id, name]), [
        ["updated", "本地新名"], ["legacy", "远端新名"], ["fallback", "远端新名"],
    ]);
});

test("远端墓碑新于或等于分类版本时剔除分类", () => {
    const result = mergeCategories([
        { id: "older", name: "旧分类", createdAt: 1, updatedAt: 4 },
        { id: "equal", name: "同版本", createdAt: 5 },
        { id: "newer", name: "更新后的分类", createdAt: 1, updatedAt: 8 },
    ], [], [], [
        { id: "older", deletedAt: 5 }, { id: "equal", deletedAt: 5 }, { id: "newer", deletedAt: 7 },
    ]);
    assert.deepEqual(result.categories.map(({ id }) => id), ["newer"]);
    assert.equal(result.deletedCategories.length, 3);
});

test("本地已删分类不会被远端陈旧副本复活，反复合并幂等", () => {
    const remote = [{ id: "deleted", name: "远端仍存在", createdAt: 1, updatedAt: 2 }];
    const result = mergeCategories([], remote, [{ id: "deleted", deletedAt: 3 }], []);
    assert.deepEqual(result, { categories: [], deletedCategories: [{ id: "deleted", deletedAt: 3 }] });
    assert.deepEqual(mergeCategories(result.categories, remote, result.deletedCategories, []), result);
});

test("分类 updatedAt 晚于墓碑时保留分类和墓碑", () => {
    const category = { id: "newer", name: "删除之后的较新版本", createdAt: 1, updatedAt: 5 };
    const tombstone = { id: "newer", deletedAt: 4 };
    assert.deepEqual(mergeCategories([category], [], [], [tombstone]), {
        categories: [category], deletedCategories: [tombstone],
    });
});

test("墓碑按 ID 取并集并保留更晚 deletedAt，不清除未匹配分类的墓碑", () => {
    const result = mergeCategories([], [], [
        { id: "both", deletedAt: 2 }, { id: "local", deletedAt: 1 }, { id: "both", deletedAt: 3 },
    ], [
        { id: "both", deletedAt: 4 }, { id: "remote", deletedAt: 5 },
    ]);
    assert.deepEqual(result.deletedCategories, [
        { id: "local", deletedAt: 1 }, { id: "both", deletedAt: 4 }, { id: "remote", deletedAt: 5 },
    ]);
});

test("合并分类按 createdAt 升序且无重复 ID，空输入安全", () => {
    const result = mergeCategories([
        { id: "last", name: "最后", createdAt: 9 },
        { id: "first", name: "最早", createdAt: 1 },
        { id: "last", name: "最后新版", createdAt: 9, updatedAt: 10 },
    ], [
        { id: "middle", name: "中间", createdAt: 5 },
        { id: "first", name: "最早远端旧版", createdAt: 1 },
    ], [], []);
    assert.deepEqual(result.categories.map(({ id }) => id), ["first", "middle", "last"]);
    assert.equal(new Set(result.categories.map(({ id }) => id)).size, result.categories.length);
    assert.deepEqual(mergeCategories(), { categories: [], deletedCategories: [] });
});

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
