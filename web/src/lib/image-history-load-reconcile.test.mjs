import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/(user)/image/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("image.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

function callback(name, scope) {
    let declaration;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(declaration, "missing " + name);
    return vm.runInNewContext(compile("(" + declaration.initializer.getText(ast) + ")"), scope);
}

function missingLogs(localLogs, remoteIds) {
    return localLogs.filter((log) => !remoteIds.has(log.id));
}

function historyScope({ localLogs, remotePages, onUpload = () => {}, onStateChange = () => {} }) {
    let pageIndex = 0;
    let owner = "owner-a";
    let currentToken = "token-a";
    const recentRemoteIds = { current: null };
    const state = { categories: [], deletedCategories: [] };
    const load = callback("loadAccountImageHistory", {
        token: currentToken,
        historyPageRequestRef: { current: null },
        historySyncRef: { current: { owner: "", failures: 0, timer: null, warnedAt: 0, running: false } },
        syncedImageCategoriesRef: { current: null },
        remoteHistoryLogIdsRef: recentRemoteIds,
        saveLogChainRef: { current: Promise.resolve() },
        useUserStore: {
            getState: () => ({ token: currentToken, user: owner ? { id: owner } : null }),
        },
        fetchImageGenerationLogsPage: async () => remotePages[pageIndex++] || { items: [], nextCursor: null },
        fetchUserImageCategories: async () => state,
        readStoredLogs: async () => localLogs,
        readStoredImageCategories: async () => state,
        mergeGenerationLogs: async (remote, local) => [...remote, ...local],
        mergeImageCategories: () => state,
        withWorkflowLogCategories: (logs, categories) => ({ logs, categories }),
        replaceStoredImageHistory: async () => state,
        sameImageCategoryState: () => true,
        syncStoredImageCategories: async () => state,
        setHistoryLoading: () => {},
        setHistoryCursor: () => {},
        setCategories: () => onStateChange(),
        setLogs: () => {},
        persistImageHistory: async (logs, categories) => onUpload({ logs, categories }),
        imageHistoryLogsMissingFromRemote: missingLogs,
        message: { error: () => {} },
    });
    return {
        load,
        recentRemoteIds,
        switchOwner: (nextOwner, nextToken) => {
            owner = nextOwner;
            currentToken = nextToken;
        },
    };
}

async function flushAsync() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

test("页面加载发现本地有 3 条而远端为空时自动补传 3 条", async () => {
    const uploads = [];
    const harness = historyScope({
        localLogs: [{ id: "a" }, { id: "b" }, { id: "c" }],
        remotePages: [{ items: [], nextCursor: null }],
        onUpload: ({ logs }) => uploads.push(logs.map((log) => log.id)),
    });
    await harness.load();
    await flushAsync();
    assert.deepEqual(uploads, [["a", "b", "c"]]);
});

test("本地与远端 id 一致时页面加载不发起补传", async () => {
    const uploads = [];
    const harness = historyScope({
        localLogs: [{ id: "a" }, { id: "b" }, { id: "c" }],
        remotePages: [{ items: [{ id: "a" }, { id: "b" }, { id: "c" }], nextCursor: null }],
        onUpload: ({ logs }) => uploads.push(logs.map((log) => log.id)),
    });
    await harness.load();
    await flushAsync();
    assert.deepEqual(uploads, []);
});

test("本地 5 条、远端 3 条时只补传缺失的 2 条", async () => {
    const uploads = [];
    const harness = historyScope({
        localLogs: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
        remotePages: [{ items: [{ id: "a" }, { id: "b" }, { id: "c" }], nextCursor: null }],
        onUpload: ({ logs }) => uploads.push(logs.map((log) => log.id)),
    });
    await harness.load();
    await flushAsync();
    assert.deepEqual(uploads, [["d", "e"]]);
});

test("远端还有下一页时只对账首页，后续页累计远端 id 但不重复补传", async () => {
    const uploads = [];
    const harness = historyScope({
        localLogs: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
        remotePages: [
            { items: [{ id: "a" }, { id: "b" }], nextCursor: "page-2" },
            { items: [{ id: "c" }, { id: "d" }], nextCursor: null },
        ],
        onUpload: ({ logs }) => uploads.push(logs.map((log) => log.id)),
    });
    await harness.load();
    await flushAsync();
    assert.deepEqual(uploads, [["c", "d", "e"]]);
    assert.equal(harness.recentRemoteIds.current.ids.size, 2);
    await harness.load("page-2");
    await flushAsync();
    assert.deepEqual(uploads, [["c", "d", "e"]]);
    assert.equal(harness.recentRemoteIds.current.ids.size, 4);
});

test("对账失败不影响页面状态，并交给现有同步退避处理", async () => {
    const errors = [];
    const harness = historyScope({
        localLogs: [{ id: "a" }],
        remotePages: [{ items: [], nextCursor: null }],
        onUpload: async () => {
            errors.push("sync failed");
            throw new Error("offline");
        },
    });
    await assert.doesNotReject(() => harness.load());
    await flushAsync();
    assert.deepEqual(errors, ["sync failed"]);
});

test("切号后迟到的对账结果作废，不向新账号上传日志", async () => {
    const uploads = [];
    let owner = "owner-a";
    let currentToken = "token-a";
    const load = callback("loadAccountImageHistory", {
        token: "token-a",
        historyPageRequestRef: { current: null },
        historySyncRef: { current: { owner: "", failures: 0, timer: null, warnedAt: 0, running: false } },
        syncedImageCategoriesRef: { current: null },
        remoteHistoryLogIdsRef: { current: null },
        saveLogChainRef: { current: Promise.resolve() },
        useUserStore: { getState: () => ({ token: currentToken, user: owner ? { id: owner } : null }) },
        fetchImageGenerationLogsPage: async () => {
            owner = "owner-b";
            currentToken = "token-b";
            return { items: [], nextCursor: null };
        },
        fetchUserImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        readStoredLogs: async () => [{ id: "old-a" }],
        readStoredImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        mergeGenerationLogs: async (remote, local) => [...remote, ...local],
        mergeImageCategories: () => ({ categories: [], deletedCategories: [] }),
        withWorkflowLogCategories: (logs, categories) => ({ logs, categories }),
        replaceStoredImageHistory: async (logs, categories) => ({ logs, categories }),
        sameImageCategoryState: () => true,
        syncStoredImageCategories: async (_, state) => state,
        setHistoryLoading: () => {},
        setHistoryCursor: () => {},
        setCategories: () => {},
        setLogs: () => {},
        persistImageHistory: async (logs) => uploads.push(logs.map((log) => log.id)),
        imageHistoryLogsMissingFromRemote: missingLogs,
        message: { error: () => {} },
    });
    await load();
    await flushAsync();
    assert.deepEqual(uploads, []);
});

test("同一账号 token 轮换后不误判换号，页面加载仍可补传", async () => {
    const uploads = [];
    let currentToken = "token-a";
    const load = callback("loadAccountImageHistory", {
        token: "token-a",
        historyPageRequestRef: { current: null },
        historySyncRef: { current: { owner: "", failures: 0, timer: null, warnedAt: 0, running: false } },
        syncedImageCategoriesRef: { current: null },
        remoteHistoryLogIdsRef: { current: null },
        saveLogChainRef: { current: Promise.resolve() },
        useUserStore: { getState: () => ({ token: currentToken, user: { id: "owner-a" } }) },
        fetchImageGenerationLogsPage: async () => {
            currentToken = "token-b";
            return { items: [], nextCursor: null };
        },
        fetchUserImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        readStoredLogs: async () => [{ id: "a" }],
        readStoredImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        mergeGenerationLogs: async (remote, local) => [...remote, ...local],
        mergeImageCategories: () => ({ categories: [], deletedCategories: [] }),
        withWorkflowLogCategories: (logs, categories) => ({ logs, categories }),
        replaceStoredImageHistory: async (logs, categories) => ({ logs, categories }),
        sameImageCategoryState: () => true,
        syncStoredImageCategories: async (_, state) => state,
        setHistoryLoading: () => {},
        setHistoryCursor: () => {},
        setCategories: () => {},
        setLogs: () => {},
        persistImageHistory: async (logs) => uploads.push(logs.map((log) => log.id)),
        imageHistoryLogsMissingFromRemote: missingLogs,
        message: { error: () => {} },
    });
    await load();
    await flushAsync();
    assert.deepEqual(uploads, [["a"]]);
});

test("账号未变但 active 失效时不启动对账上传", async () => {
    const uploads = [];
    const requestRef = { current: null };
    const load = callback("loadAccountImageHistory", {
        token: "token-a",
        historyPageRequestRef: requestRef,
        historySyncRef: { current: { owner: "", failures: 0, timer: null, warnedAt: 0, running: false } },
        syncedImageCategoriesRef: { current: null },
        remoteHistoryLogIdsRef: { current: null },
        saveLogChainRef: { current: Promise.resolve() },
        useUserStore: { getState: () => ({ token: "token-a", user: { id: "owner-a" } }) },
        fetchImageGenerationLogsPage: async () => ({ items: [], nextCursor: null }),
        fetchUserImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        readStoredLogs: async () => [{ id: "old-a" }],
        readStoredImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        mergeGenerationLogs: async (remote, local) => [...remote, ...local],
        mergeImageCategories: () => ({ categories: [], deletedCategories: [] }),
        withWorkflowLogCategories: (logs, categories) => ({ logs, categories }),
        replaceStoredImageHistory: async () => {
            requestRef.current = { token: "token-a", loading: true };
            return { categories: [], deletedCategories: [] };
        },
        sameImageCategoryState: () => true,
        syncStoredImageCategories: async (_, state) => state,
        setHistoryLoading: () => {},
        setHistoryCursor: () => {},
        setCategories: () => {},
        setLogs: () => {},
        persistImageHistory: async (logs) => uploads.push(logs.map((log) => log.id)),
        imageHistoryLogsMissingFromRemote: missingLogs,
        message: { error: () => {} },
    });
    await load();
    await flushAsync();
    assert.deepEqual(uploads, []);
});
