import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { mergeImageCategories } from "./image-log-categories.ts";

const source = readFileSync(new URL("../app/(user)/image/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("image.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
    let found;
    function visit(node) {
        if (!found && (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(ast) === name) found = node;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(found, "missing " + name);
    return found;
}
function functionSource(name) {
    const node = declaration(name);
    return ts.isVariableDeclaration(node) ? node.initializer.getText(ast) : node.getText(ast);
}
function callback(name, scope) {
    const code = ts.transpileModule("(" + functionSource(name) + ")", {
        compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText;
    return vm.runInNewContext(code, scope);
}

test("图片工作台分类写入接上账号同步，改名和删除均产生版本", () => {
    const persist = functionSource("persistImageHistory");
    assert.doesNotMatch(persist, /_nextCategories/);
    assert.match(persist, /sync\w*Categor/);
    for (const name of ["createCategory", "renameCategory", "deleteCategory"]) {
        assert.match(functionSource(name), /persistImageHistory\(/, name + " must trigger category synchronization");
    }
    assert.match(functionSource("createCategory"), /updatedAt/);
    assert.match(functionSource("renameCategory"), /updatedAt/);
    assert.match(functionSource("deleteCategory"), /deletedAt/);
});

test("分页日志载入同时合并远端分类，保留工作流分类兜底", () => {
    const load = functionSource("loadAccountImageHistory");
    assert.match(load, /fetchUserImageCategories\(token\)/);
    assert.match(load, /mergeImageCategories\(/);
    assert.match(load, /withWorkflowLogCategories\(/);
    assert.match(load, /sync\w*Categor/);
    assert.doesNotMatch(load, /accountHistorySyncEnabledRef/);
});

test("工作流分类兜底复用未知 ID，但不会复活已删分类", () => {
    const fallback = callback("withWorkflowLogCategories", { nanoid: () => "new-category" });
    const logs = [
        { id: "recover", workflowName: "工作流", categoryIds: ["missing"] },
        { id: "deleted", workflowName: "已删除工作流", categoryIds: ["deleted-category"] },
    ];
    const result = fallback(logs, [], [{ id: "deleted-category", deletedAt: 10 }]);
    assert.deepEqual(Array.from(result.categories, ({ id, name }) => ({ id, name })), [{ id: "missing", name: "工作流" }]);
    assert.deepEqual(Array.from(result.logs.find(({ id }) => id === "deleted").categoryIds), []);
    const removed = fallback([{ id: "legacy", workflowName: "已取消分类", categoryIds: [] }], [], [{ id: "deleted-category", deletedAt: 10 }]);
    assert.equal(removed.categories.length, 0);
});

test("恢复的工作流分类沿用日志创建时间，不把旧引用升级成能盖过删除的新版", () => {
    const fallback = callback("withWorkflowLogCategories", { nanoid: () => "new-category" });
    const result = fallback([{ id: "old-log", createdAt: 1, workflowName: "旧工作流", categoryIds: ["old-category"] }], []);
    assert.equal(result.categories[0].createdAt, 1);
    const merged = mergeImageCategories(result.categories, [], [], [{ id: "old-category", deletedAt: 2 }]);
    assert.deepEqual(merged.categories, []);
});

test("已重命名工作流分类保持原 ID，不再按旧 workflowName 创建分类", () => {
    const fallback = callback("withWorkflowLogCategories", { nanoid: assert.fail });
    const categories = [{ id: "workflow", name: "新名称", createdAt: 1, updatedAt: 2 }];
    const logs = [{ id: "log", workflowName: "旧名称", categoryIds: ["workflow"] }];
    const result = fallback(logs, categories, []);
    assert.equal(result.categories, categories);
    assert.equal(result.logs, logs);
});

test("日志仍逐次 upsert，只有分类变化才追加分类同步", async () => {
    const initial = { id: "a", name: "原分类", createdAt: 1 };
    const added = { id: "b", name: "新分类", createdAt: 2, updatedAt: 2 };
    const stateRef = { current: { token: "owner", state: { categories: [initial], deletedCategories: [] } } };
    const syncs = [];
    const logWrites = [];
    let stored = stateRef.current.state;
    const persist = callback("persistImageHistory", {
        token: "owner", historySyncRef: { current: { owner: "owner", failures: 0, timer: null, warnedAt: 0, running: false } },
        syncedImageCategoriesRef: stateRef,
        useUserStore: { getState: () => ({ token: "owner", user: { id: "owner" } }) },
        serializeLog: (log) => log,
        upsertImageGenerationLogs: async (...args) => { logWrites.push(args); },
        readStoredImageCategories: async () => stored,
        mergeImageCategories,
        sameImageCategoryState: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        syncStoredImageCategories: async (_, state) => { syncs.push(state); stored = state; return state; },
        setCategories: () => {},
        message: { warning: assert.fail },
        clearTimeout: () => {},
        Date,
        IMAGE_HISTORY_SYNC_WARNING_INTERVAL_MS: 60000,
        IMAGE_HISTORY_SYNC_FAILURE_HINT: "sync failed",
        scheduleImageHistorySyncRetry: assert.fail,
        retryImageHistorySync: async () => {},
    });
    await persist([{ id: "log" }], [initial]);
    assert.equal(syncs.length, 0);
    await persist([{ id: "log" }], [initial, added]);
    assert.equal(syncs.length, 1);
    await persist([{ id: "log" }], [initial, added]);
    assert.equal(syncs.length, 1);
    assert.equal(logWrites.length, 3);
});

test("分类远端同步失败只安排重试，已保存的本地定义仍保留", async () => {
    const stored = { categories: [{ id: "local", name: "本地分类", createdAt: 1 }], deletedCategories: [] };
    const state = { current: { owner: "owner", failures: 0, timer: null, warnedAt: 0, running: false } };
    const timers = [];
    const warnings = [];
    const persist = callback("persistImageHistory", {
        token: "owner", historySyncRef: state, syncedImageCategoriesRef: { current: null },
        useUserStore: { getState: () => ({ token: "owner", user: { id: "owner" } }) },
        serializeLog: (log) => log,
        upsertImageGenerationLogs: async () => {},
        readStoredImageCategories: async () => stored,
        mergeImageCategories,
        syncStoredImageCategories: async () => { throw new Error("offline"); },
        setCategories: assert.fail,
        message: { warning: (text) => warnings.push(text) },
        clearTimeout: () => {},
        setTimeout: () => { timers.push(1); return timers.length; },
        Date,
        IMAGE_HISTORY_SYNC_WARNING_INTERVAL_MS: 60000,
        IMAGE_HISTORY_SYNC_FAILURE_HINT: "sync failed",
        scheduleImageHistorySyncRetry: (current, owner) => { current.timer = 1; timers.push(owner); },
        retryImageHistorySync: async () => {},
    });
    await persist([], stored.categories);
    assert.equal(state.current.failures, 1);
    assert.equal(state.current.timer, 1);
    assert.deepEqual(warnings, ["sync failed"]);
    assert.equal(stored.categories[0].name, "本地分类");
});

test("切号后旧页面的新建改名与删除回调不能写入当前账号分类", async () => {
    const category = { id: "old", name: "旧账号分类", createdAt: 1 };
    const writes = [];
    let confirmation;
    const scope = {
        token: "old-token", useUserStore: { getState: () => ({ token: "new-token" }) },
        categories: [category], logs: [], activeResultCategoryId: null,
        resolveCategoryByName: () => undefined, nanoid: () => "new", Date,
        writeStoredImageCategories: async (state) => { writes.push(state); return state; },
        persistImageHistory: async () => {}, setCategories: () => {}, setLogs: () => {},
        serializeLog: (log) => log, logStore: { setItem: async () => {} },
        modal: { confirm: (value) => { confirmation = value; } },
        message: { success: () => {}, error: () => {} },
    };
    await callback("createCategory", scope)("新分类");
    await callback("renameCategory", scope)(category, "新名称");
    callback("deleteCategory", scope)(category);
    if (confirmation) await confirmation.onOk();
    assert.equal(writes.length, 0);
});

test("分类 GET 离线仍加载日志页与本地分类，并保留日志上传能力", async () => {
    const local = { categories: [{ id: "local", name: "本地分类", createdAt: 1 }], deletedCategories: [] };
    const state = { current: { owner: "", failures: 0, timer: null, warnedAt: 0, running: false } };
    const categoryViews = [];
    const logViews = [];
    const load = callback("loadAccountImageHistory", {
        token: "owner", historyPageRequestRef: { current: null },
        historySyncRef: state, saveLogChainRef: { current: Promise.resolve() },
        syncedImageCategoriesRef: { current: null },
        useUserStore: { getState: () => ({ token: "owner" }) },
        fetchImageGenerationLogsPage: async () => ({ items: [{ id: "remote-log" }], nextCursor: null }),
        fetchUserImageCategories: async () => { throw new Error("offline"); },
        readStoredLogs: async () => [{ id: "local-log" }],
        readStoredImageCategories: async () => local,
        mergeGenerationLogs: async (remote, local) => [...remote, ...local],
        mergeImageCategories,
        withWorkflowLogCategories: (logs, categories) => ({ logs, categories }),
        replaceStoredImageHistory: async (_, categories, deletedCategories) => ({ categories, deletedCategories }),
        setHistoryLoading: () => {}, setHistoryCursor: () => {},
        setCategories: (categories) => { categoryViews.push(categories); },
        setLogs: (logs) => { logViews.push(logs); },
        syncStoredImageCategories: assert.fail,
        message: { error: assert.fail },
    });
    const result = await load();
    assert.equal(state.current.failures, 0);
    assert.equal(state.current.timer, null);
    assert.deepEqual(Array.from(result, ({ id }) => id), ["remote-log", "local-log"]);
    assert.equal(logViews.length, 1);
    assert.equal(categoryViews.at(-1)[0].id, "local");
});
