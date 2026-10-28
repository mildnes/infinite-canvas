import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/(user)/image/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("image.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const mergeDeclaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "mergeGenerationLogs");
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
function mergeHarness() {
    return vm.runInNewContext(compile("(" + mergeDeclaration.getText(ast) + ")"), {
        normalizeLog: async (log) => log,
        imageLogIdentityKeys: (log) => [log.id],
        shouldPreserveLocalImageLogDuringRemoteMerge: (log) => log.config.channelMode === "local",
        dedupeGenerationLogs: (logs) => Array.from(new Map(logs.map((log) => [log.id, log])).values()),
    });
}
test("分页合并保留本页未返回的本地云端日志，下一页仍走既有合并", async () => {
    const merge = mergeHarness();
    const local = [{ id: "old-remote", status: "成功", config: { channelMode: "remote" } }, { id: "local", config: { channelMode: "local" } }];
    const first = await merge([{ id: "newest", config: { channelMode: "remote" } }], local, true);
    assert.deepEqual(Array.from(first, (log) => log.id), ["newest", "old-remote", "local"]);
    const next = await merge([{ id: "older-page", config: { channelMode: "remote" } }], first, true);
    assert.equal(next.length, 4);
    assert.ok(next.some((log) => log.id === "newest"));
});
test("首屏只请求40条摘要，有加载更多入口，回写使用upsert", () => {
    assert.match(source, /fetchImageGenerationLogsPage<GenerationLog>\(token, 40, cursor\)/);
    assert.doesNotMatch(source, /fetchImageGenerationLogs<GenerationLog>/);
    assert.match(source, /加载更多/);
    assert.match(source, /upsertImageGenerationLogs\(ownerToken,/);
});

function pageCallback(name, scope) {
    let declaration;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    return vm.runInNewContext(compile("(" + declaration.initializer.getText(ast) + ")"), scope);
}

test("真实分页回调只拉一页并用合并全集更新本地，不按页清空历史", async () => {
    let saved = [{ id: "older-local", config: { channelMode: "remote" } }];
    let cursor;
    const requests = [];
    const requestRef = { current: null };
    const load = pageCallback("loadAccountImageHistory", {
        token: "owner", historyPageRequestRef: requestRef,
        useUserStore: { getState: () => ({ token: "owner" }) },
        setHistoryLoading: () => {}, setHistoryCursor: (next) => { cursor = next; },
        accountHistorySyncEnabledRef: { current: false }, saveLogChainRef: { current: Promise.resolve() },
        syncedImageCategoriesRef: { current: null },
        fetchImageGenerationLogsPage: async (...args) => { requests.push(args); return { items: [{ id: "page", config: { channelMode: "remote" } }], nextCursor: "next" }; },
        fetchUserImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        readStoredLogs: async () => saved, readStoredImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        mergeImageCategories: () => ({ categories: [], deletedCategories: [] }),
        mergeGenerationLogs: mergeHarness(),
        withWorkflowLogCategories: (logs, categories) => ({ logs, categories }),
        replaceStoredImageHistory: async (logs, categories, deletedCategories) => { saved = logs; return { categories, deletedCategories }; },
        sameImageCategoryState: () => true,
        syncStoredImageCategories: async (_, state) => state,
        setCategories: () => {}, setLogs: () => {}, message: { error: assert.fail },
    });
    await load();
    assert.deepEqual(requests, [["owner", 40, undefined]]);
    assert.equal(cursor, "next");
    assert.deepEqual(Array.from(saved, (log) => log.id), ["page", "older-local"]);
});

test("摘要回写前补详情，保留没有下发的 originalUrl 与其它 task 字段", async () => {
    const inline = "data:image/png;base64,not-yet-verified";
    const requests = [];
    const persist = pageCallback("persistImageHistory", {
        token: "owner",
        historySyncRef: { current: { owner: "owner", failures: 0, timer: null, warnedAt: 0, running: false } },
        useUserStore: { getState: () => ({ token: "owner", user: { id: "owner" } }) },
        fetchImageGenerationLog: async () => ({ id: "log", prompt: "完整原文", references: [], task: { id: "task", originalUrl: inline, response_body: "保留详情" } }),
        serializeLog: (log) => log,
        upsertImageGenerationLogs: async (...args) => { requests.push(args); },
        readStoredImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        mergeImageCategories: () => ({ categories: [], deletedCategories: [] }),
        syncedImageCategoriesRef: { current: null },
        sameImageCategoryState: () => true,
        syncStoredImageCategories: async (_, state) => state,
        setCategories: () => {},
        message: { warning: assert.fail },
        clearTimeout: () => {},
        Date,
        IMAGE_HISTORY_SYNC_WARNING_INTERVAL_MS: 60000,
        IMAGE_HISTORY_SYNC_FAILURE_HINT: "sync failed",
        scheduleImageHistorySyncRetry: assert.fail,
        retryImageHistorySync: async () => {},
    });
    await persist([{ id: "log", summaryOnly: true, prompt: "", categoryIds: ["new"], task: { id: "task", progress: 100 } }], []);
    assert.equal(requests.length, 1);
    const saved = requests[0][1][0];
    assert.equal(saved.task.originalUrl, inline);
    assert.equal(saved.task.response_body, "保留详情");
    assert.equal(saved.task.progress, 100);
    assert.equal(saved.prompt, "完整原文");
    assert.deepEqual(Array.from(saved.categoryIds), ["new"]);
    assert.equal(saved.summaryOnly, undefined);
});
