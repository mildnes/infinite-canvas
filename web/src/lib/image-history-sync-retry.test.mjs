import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { mergeImageCategories } from "./image-log-categories.ts";

const source = readFileSync(new URL("../app/(user)/image/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("image.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

function declaration(name) {
    let found;
    function visit(node) {
        if (!found && (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(ast) === name) found = node;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(found, "missing declaration " + name);
    return found;
}
function functionSource(name) {
    const node = declaration(name);
    return ts.isVariableDeclaration(node) ? node.initializer.getText(ast) : node.getText(ast);
}
function callback(name, scope) {
    return vm.runInNewContext(compile("(" + functionSource(name) + ")"), scope);
}
function constant(name) {
    const match = source.match(new RegExp("const " + name + " = (\\[[^\\]]*\\]|\\d+);"));
    assert.ok(match, "missing constant " + name);
    return JSON.parse(match[1]);
}

function syncScope(overrides = {}) {
    const timers = [];
    const warnings = [];
    const uploads = [];
    const categorySyncs = [];
    let failuresRemaining = 0;
    const backoff = callback("imageHistorySyncBackoffMs", { IMAGE_HISTORY_SYNC_RETRY_DELAYS_MS: constant("IMAGE_HISTORY_SYNC_RETRY_DELAYS_MS") });
    const schedule = callback("scheduleImageHistorySyncRetry", {
        imageHistorySyncBackoffMs: backoff,
        setTimeout: (handler) => {
            timers.push(handler);
            return timers.length;
        },
    });
    const scope = {
        token: "owner-token",
        historySyncRef: { current: { owner: "", failures: 0, timer: null, warnedAt: 0, running: false } },
        syncedImageCategoriesRef: { current: null },
        persistImageHistoryRef: { current: null },
        useUserStore: { getState: () => ({ token: "owner-token", user: { id: "owner-a" } }) },
        serializeLog: (log) => ({ ...log }),
        fetchImageGenerationLog: async (_token, id) => ({ id, prompt: "完整原文", references: [] }),
        upsertImageGenerationLogs: async (_token, logs) => {
            if (failuresRemaining > 0) {
                failuresRemaining -= 1;
                throw new Error("offline");
            }
            uploads.push(logs.map((log) => log.id));
        },
        readStoredImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        readStoredLogs: async () => scope.storedLogs || [],
        readStoredCategories: async () => scope.storedCategories || [],
        mergeImageCategories,
        sameImageCategoryState: () => true,
        syncStoredImageCategories: async (_token, state) => {
            categorySyncs.push(state);
            return state;
        },
        setCategories: () => {},
        message: { warning: (text) => warnings.push(text), error: () => {}, success: () => {} },
        setTimeout: (handler) => {
            timers.push(handler);
            return timers.length;
        },
        clearTimeout: () => {},
        Date,
        imageHistorySyncBackoffMs: backoff,
        scheduleImageHistorySyncRetry: schedule,
        IMAGE_HISTORY_SYNC_RETRY_DELAYS_MS: constant("IMAGE_HISTORY_SYNC_RETRY_DELAYS_MS"),
        IMAGE_HISTORY_SYNC_FAILURE_HINT: "历史记录已保存在本机，同步到账号失败，其他设备暂时看不到；正在重试",
        IMAGE_HISTORY_SYNC_WARNING_INTERVAL_MS: constant("IMAGE_HISTORY_SYNC_WARNING_INTERVAL_MS"),
        retryImageHistorySync: async () => {},
        storedLogs: [{ id: "a" }],
        storedCategories: [],
    };
    return { scope, timers, warnings, uploads, categorySyncs, failNext: (count) => { failuresRemaining = count; } };
}

function sameJson(actual, expected, message) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

test("日志同步退避序列有上限但没有永久关闭", () => {
    const delays = constant("IMAGE_HISTORY_SYNC_RETRY_DELAYS_MS");
    assert.deepEqual(delays, [5000, 15000, 60000, 300000]);
    const backoff = callback("imageHistorySyncBackoffMs", { IMAGE_HISTORY_SYNC_RETRY_DELAYS_MS: delays });
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(backoff), [5000, 15000, 60000, 300000, 300000, 300000]);
});

test("同步失败不再永久熔断：退避重试补传积压日志且只提示一次", async () => {
    const h = syncScope();
    const persist = callback("persistImageHistory", h.scope);
    h.scope.persistImageHistoryRef.current = persist;
    h.scope.persistImageHistory = persist;
    h.scope.retryImageHistorySync = callback("retryImageHistorySync", h.scope);
    const state = h.scope.historySyncRef.current;

    h.failNext(2);
    await persist([{ id: "a" }], []);
    assert.equal(h.warnings.length, 1, "首次失败提示一次");
    assert.equal(h.timers.length, 1, "失败后必须安排重试");
    assert.equal(state.failures, 1);
    assert.equal(state.timer, 1);

    h.scope.storedLogs = [{ id: "a" }, { id: "b" }];
    await persist([{ id: "a" }], []);
    assert.equal(h.warnings.length, 1, "节流窗口内不重复提示");
    assert.equal(h.timers.length, 1, "同一时刻只保留一个重试定时器");
    assert.equal(state.failures, 2);

    await h.scope.retryImageHistorySync("owner-a");
    sameJson(h.uploads, [["a", "b"]], "重试必须补传期间积压的全部日志");
    assert.equal(state.failures, 0, "成功后退避计数归零");
    assert.equal(state.timer, null);
});

test("分类无需同步时日志成功也会清零退避计数", async () => {
    const h = syncScope();
    const persist = callback("persistImageHistory", h.scope);
    h.scope.historySyncRef.current = { owner: "owner-a", failures: 2, timer: 3, warnedAt: 1, running: false };
    h.scope.syncedImageCategoriesRef.current = {
        token: "owner-token",
        state: { categories: [], deletedCategories: [] },
    };
    let cleared = null;
    h.scope.clearTimeout = (timer) => { cleared = timer; };
    await persist([{ id: "a" }], []);
    assert.equal(h.scope.historySyncRef.current.failures, 0);
    assert.equal(h.scope.historySyncRef.current.timer, null);
    assert.equal(cleared, 3);
});

test("日志与分类分别统计失败，分类同步失败不阻断日志上传", async () => {
    const h = syncScope();
    h.scope.syncStoredImageCategories = async () => {
        h.categorySyncs.push("failed");
        throw new Error("category offline");
    };
    const persist = callback("persistImageHistory", h.scope);
    await persist([{ id: "a" }], [{ id: "c1", name: "分类", createdAt: 1 }]);
    sameJson(h.uploads, [["a"]], "分类同步失败前日志已经上传");
    assert.equal(h.scope.historySyncRef.current.failures, 1);
});

test("分类 GET 失败后日志上传能力保留", async () => {
    const categorySyncs = [];
    const scope = {
        token: "owner-token",
        historyPageRequestRef: { current: null },
        saveLogChainRef: { current: Promise.resolve() },
        syncedImageCategoriesRef: { current: null },
        historySyncRef: { current: { owner: "", failures: 0, timer: null, warnedAt: 0, running: false } },
        useUserStore: { getState: () => ({ token: "owner-token", user: { id: "owner-a" } }) },
        fetchImageGenerationLogsPage: async () => ({ items: [], nextCursor: null }),
        fetchUserImageCategories: async () => {
            categorySyncs.push("failed");
            throw new Error("offline");
        },
        readStoredLogs: async () => [],
        readStoredImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        mergeGenerationLogs: async (_remote, local) => local,
        mergeImageCategories,
        withWorkflowLogCategories: (logs, categories, deletedCategories) => ({ logs, categories, deletedCategories }),
        replaceStoredImageHistory: async (logs, categories, deletedCategories) => ({ categories, deletedCategories }),
        sameImageCategoryState: () => true,
        syncStoredImageCategories: async (_token, state) => state,
        setHistoryLoading: () => {},
        setHistoryCursor: () => {},
        setCategories: () => {},
        setLogs: () => {},
        message: { error: () => {} },
    };
    const load = callback("loadAccountImageHistory", scope);
    await load();
    assert.equal(scope.historySyncRef.current.failures, 0, "分类拉取失败不得记成日志同步失败");
    assert.equal(scope.historySyncRef.current.timer, null);

    const persist = callback("persistImageHistory", {
        ...scope,
        serializeLog: (log) => ({ ...log }),
        fetchImageGenerationLog: async (_token, id) => ({ id, prompt: "完整原文", references: [] }),
        upsertImageGenerationLogs: async (_token, logs) => { persist.uploads.push(logs.map((log) => log.id)); },
        setCategories: () => {},
        message: { warning: () => {} },
        setTimeout: () => 1,
        clearTimeout: () => {},
        Date,
        imageHistorySyncBackoffMs: () => 5000,
        IMAGE_HISTORY_SYNC_WARNING_INTERVAL_MS: 60000,
        retryImageHistorySync: async () => {},
    });
    persist.uploads = [];
    await persist([{ id: "generated" }], []);
    sameJson(persist.uploads, [["generated"]], "分类拉取失败后新生成的日志仍要上传");
});

test("新浏览器首次登录远端为空后，新生成日志仍会进入同步队列", async () => {
    const h = syncScope();
    const load = callback("loadAccountImageHistory", {
        token: "owner-token",
        historyPageRequestRef: { current: null },
        saveLogChainRef: { current: Promise.resolve() },
        syncedImageCategoriesRef: { current: null },
        historySyncRef: h.scope.historySyncRef,
        useUserStore: h.scope.useUserStore,
        fetchImageGenerationLogsPage: async () => ({ items: [], nextCursor: null }),
        fetchUserImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        readStoredLogs: async () => [],
        readStoredImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        mergeGenerationLogs: async () => [],
        mergeImageCategories,
        withWorkflowLogCategories: (logs, categories, deletedCategories) => ({ logs, categories, deletedCategories }),
        replaceStoredImageHistory: async (logs, categories, deletedCategories) => ({ logs, categories, deletedCategories }),
        sameImageCategoryState: () => true,
        syncStoredImageCategories: async (_token, state) => state,
        setHistoryLoading: () => {},
        setHistoryCursor: () => {},
        setCategories: () => {},
        setLogs: () => {},
        message: { error: () => {} },
    });
    await load();
    assert.equal(h.scope.historySyncRef.current.failures, 0);

    const persist = callback("persistImageHistory", h.scope);
    await persist([{ id: "first-image" }], []);
    sameJson(h.uploads, [["first-image"]], "空的远端首屏不得关闭后续上传");
});

test("切换账号后旧账号的待重试不再写入且计数复位", async () => {
    const uploads = [];
    const cleared = [];
    const scope = {
        token: "owner-token",
        historySyncRef: { current: { owner: "owner-a", failures: 3, timer: 7, warnedAt: 1, running: false } },
        syncedImageCategoriesRef: { current: null },
        persistImageHistoryRef: { current: null },
        useUserStore: { getState: () => ({ token: "owner-token", user: { id: "owner-b" } }) },
        serializeLog: (log) => ({ ...log }),
        fetchImageGenerationLog: async (_token, id) => ({ id, prompt: "完整原文", references: [] }),
        upsertImageGenerationLogs: async (_token, logs) => { uploads.push(logs.map((log) => log.id)); },
        readStoredImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        readStoredLogs: async () => [{ id: "from-old-account" }],
        readStoredCategories: async () => [],
        mergeImageCategories,
        sameImageCategoryState: () => true,
        syncStoredImageCategories: async (_token, state) => state,
        setCategories: () => {},
        message: { warning: () => {} },
        setTimeout: () => 9,
        clearTimeout: (timer) => cleared.push(timer),
        Date,
        imageHistorySyncBackoffMs: () => 5000,
        IMAGE_HISTORY_SYNC_WARNING_INTERVAL_MS: 60000,
        retryImageHistorySync: async () => {},
    };
    const retry = callback("retryImageHistorySync", scope);
    await retry("owner-a");
    assert.equal(uploads.length, 0, "迟到的旧账号重试不能写入新账号");

    const persist = callback("persistImageHistory", scope);
    scope.persistImageHistoryRef.current = persist;
    await persist([{ id: "new-log" }], []);
    const state = scope.historySyncRef.current;
    sameJson(cleared, [7], "切号必须撤掉旧账号的待重试定时器");
    assert.equal(state.owner, "owner-b");
    assert.equal(state.failures, 0);
    sameJson(uploads, [["new-log"]]);
});

test("同账号 token 轮换中断在途同步后自动续排，不使用旧令牌重试", async () => {
    const h = syncScope();
    let currentToken = "owner-token";
    const retries = [];
    h.scope.useUserStore = { getState: () => ({ token: currentToken, user: { id: "owner-a" } }) };
    h.scope.upsertImageGenerationLogs = async (token, logs) => {
        h.uploads.push({ token, ids: logs.map((log) => log.id) });
        currentToken = "rotated-token";
    };
    h.scope.retryImageHistorySync = async (owner) => { retries.push(owner); };
    const persist = callback("persistImageHistory", h.scope);
    await persist([{ id: "during-rotation" }], []);

    sameJson(h.uploads, [{ token: "owner-token", ids: ["during-rotation"] }]);
    assert.equal(h.warnings.length, 0, "同账号令牌刷新不应显示同步失败");
    assert.equal(h.scope.historySyncRef.current.failures, 0);
    assert.equal(h.timers.length, 1, "同账号令牌轮换后必须重新排队同步");
    h.timers.shift()();
    sameJson(retries, ["owner-a"]);
});

test("页面重新可见时立即补传积压数据", () => {
    assert.match(source, /addEventListener\("visibilitychange"/);
    const start = source.indexOf("const owner = userId || token;");
    const end = source.indexOf("}, [token, userId]);", start);
    assert.ok(start >= 0 && end > start, "缺少页面可见性监听 effect");
    const effect = source.slice(start, end);
    const cleanup = effect.match(/return \(\) => \{([\s\S]*?)\};/);
    assert.ok(cleanup, "缺少可见性监听清理函数");
    assert.match(effect, /retryImageHistorySyncRef\.current/);
    assert.match(effect, /const currentOwner = useUserStore\.getState\(\)\.user\?\.id \|\| useUserStore\.getState\(\)\.token/);
    assert.doesNotMatch(cleanup[1], /clearTimeout/, "重绑监听时不得取消已排队的同账号重试");
});

test("页面卸载才清理待重试定时器，同账号 token 轮换保留重试", () => {
    assert.match(source, /useEffect\(\(\) => \(\) => \{[\s\S]*?clearTimeout\(state\.timer\)[\s\S]*?\}, \[\]\);/);
});

test("同步能力不再被布尔熔断关闭", () => {
    assert.doesNotMatch(source, /accountHistorySyncEnabledRef/);
    assert.match(source, /function scheduleImageHistorySyncRetry\([\s\S]*imageHistorySyncBackoffMs\(/);
    const persist = functionSource("persistImageHistory");
    assert.match(persist, /IMAGE_HISTORY_SYNC_WARNING_INTERVAL_MS/);
    assert.match(persist, /scheduleImageHistorySyncRetry\(/);
    assert.doesNotMatch(persist, /SyncEnabled/);
});
