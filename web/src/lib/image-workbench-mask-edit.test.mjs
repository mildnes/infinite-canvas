import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { IMAGE_MASK_EDIT_PROMPT_PREFIX } from "./image-reference-prompt.ts";

const source = readFileSync(new URL("../app/(user)/image/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("image.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const plain = (value) => JSON.parse(JSON.stringify(value));
function callback(name, scope = {}, tree = ast) {
    let declaration;
    function visit(node) {
        if (!declaration && (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(tree) === name) declaration = node;
        ts.forEachChild(node, visit);
    }
    visit(tree);
    assert.ok(declaration, `工作台必须实现 ${name}`);
    const body = ts.isVariableDeclaration(declaration) ? declaration.initializer.getText(tree) : declaration.getText(tree);
    const code = ts.transpileModule(`(${body.replace(/^export default /, "")})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, jsxFactory: "jsx", jsxFragmentFactory: "Fragment" },
    }).outputText;
    return vm.runInNewContext(code, { Error, ...scope });
}

const image = { id: "original-image", dataUrl: "original.png", storageKey: "server:original", width: 100, height: 100, bytes: 10, durationMs: 2 };
const config = {
    channelMode: "remote", imageModel: "current-model", imageChannelId: "current-channel", activeChannelId: "current-channel",
    quality: "medium", size: "1024x1024", count: "5",
    publicChannels: [
        { id: "current-channel", models: ["current-model", "original-model"] },
        { id: "original-channel", models: ["original-model"] },
    ],
};
const originalLog = {
    id: "original-log", model: "legacy-model", prompt: "原始提示词", config: { imageModel: "original-model", imageChannelId: "original-channel", quality: "high", size: "1536x1024" },
    references: [], categoryIds: ["original-category"], images: [image], errors: [], imageCount: 1, status: "成功",
};
const payload = { prompt: "  改成红色  ", markedDataUrl: "data:image/png;base64,marked", model: "original-model", channelId: "original-channel" };

function openingScope(extra = {}) {
    let target;
    return {
        scope: {
            effectiveConfig: config, model: config.imageModel,
            imageTaskChannelId: callback("imageTaskChannelId"),
            resolveImageChannelId: callback("resolveImageChannelId"),
            loadCompleteImageLog: async (log) => log,
            setMaskEditTarget: (value) => { target = value; },
            message: { error: assert.fail },
            ...extra,
        },
        target: () => target,
    };
}

test("局部重绘沿用日志模型、渠道、质量和尺寸，缺失时回当前配置", async () => {
    const h = openingScope();
    const open = callback("openMaskEdit", h.scope);
    await open(originalLog, image);
    assert.deepEqual(plain(h.target()), { image, model: "original-model", channelMode: "remote", channelId: "original-channel", quality: "high", size: "1536x1024", open: true });
    await open({ ...originalLog, model: "", config: {} }, image);
    assert.deepEqual(plain(h.target()), { image, model: "current-model", channelMode: "remote", channelId: "current-channel", quality: "medium", size: "1024x1024", open: true });
    await open({ ...originalLog, model: "original-model", config: {} }, image);
    assert.equal(h.target().model, "original-model");
});

test("历史用户渠道按原 channelMode 解析，同名系统模型不能抢走用户渠道", async () => {
    const local = { ...config, channelMode: "local", localChannels: [{ id: "user-channel", models: ["original-model"] }] };
    const h = openingScope({
        effectiveConfig: local,
        resolveImageChannelId: callback("resolveImageChannelId", { normalizeLocalChannels: (value) => value.localChannels }),
    });
    await callback("openMaskEdit", h.scope)({
        ...originalLog, config: { ...originalLog.config, channelMode: "remote" },
    }, image);
    assert.equal(h.target().channelMode, "remote");
    assert.equal(h.target().channelId, "original-channel");
    await callback("openMaskEdit", h.scope)({
        ...originalLog, config: { ...originalLog.config, channelMode: "local", imageChannelId: "user-channel" },
    }, image);
    assert.equal(h.target().channelMode, "local");
    assert.equal(h.target().channelId, "user-channel");
});

test("摘要历史先补全配置，再打开重绘；读取失败不打开", async () => {
    let reads = 0;
    const h = openingScope({ loadCompleteImageLog: async () => { reads++; return originalLog; } });
    await callback("openMaskEdit", h.scope)({ ...originalLog, summaryOnly: true, config: {} }, image);
    assert.equal(reads, 1);
    assert.equal(h.target().quality, "high");
    const errors = [];
    const failed = openingScope({ loadCompleteImageLog: async () => { throw new Error("读取失败"); }, message: { error: (value) => errors.push(value) } });
    await callback("openMaskEdit", failed.scope)({ ...originalLog, summaryOnly: true }, image);
    assert.equal(failed.target(), undefined);
    assert.equal(errors.length, 1);
});

function submissionScope(extra = {}) {
    const submissions = [];
    const uploads = [];
    const errors = [];
    let target = { image, model: "original-model", channelMode: "remote", channelId: "original-channel", quality: "high", size: "1536x1024", open: true };
    const scope = {
        token: "owner", effectiveConfig: config, maskEditTarget: target, IMAGE_MASK_EDIT_PROMPT_PREFIX,
        useUserStore: { getState: () => ({ token: "owner" }) },
        buildRequestSnapshot: (options) => ({
            text: options.promptText, requestConfig: { ...config, ...options.configOverride },
            displayConfig: { ...config, ...options.configOverride, count: String(options.taskCount) },
            references: options.referenceItems || [], workflowRef: options.workflowRef || undefined,
        }),
        uploadImage: async (...args) => { uploads.push(args); return { mimeType: "image/png", url: "marked.png", storageKey: "local:marked" }; },
        nanoid: () => "marked-reference",
        submitGenerationBatch: async (snapshot) => { submissions.push(snapshot); return true; },
        setMaskEditTarget: (updater) => { target = updater(target); },
        message: { error: (value) => errors.push(value) },
        ...extra,
    };
    return { scope, submissions, uploads, errors, target: () => target };
}

test("重绘提交共享提示词前缀、临时标记图和单张原配置，不修改原图", async () => {
    const before = plain(originalLog);
    const h = submissionScope();
    await callback("submitMaskEdit", h.scope)(payload);
    assert.equal(h.submissions.length, 1);
    const submitted = h.submissions[0];
    assert.equal(submitted.text, `${IMAGE_MASK_EDIT_PROMPT_PREFIX}改成红色`);
    assert.equal(submitted.displayConfig.count, "1");
    assert.equal(submitted.requestConfig.imageModel, "original-model");
    assert.equal(submitted.requestConfig.imageChannelId, "original-channel");
    assert.equal(submitted.requestConfig.channelMode, "remote");
    assert.equal(submitted.requestConfig.quality, "high");
    assert.equal(submitted.requestConfig.size, "1536x1024");
    assert.equal(submitted.workflowRef, undefined);
    assert.deepEqual(plain(submitted.references), [{ id: "marked-reference", name: "mask-edit.png", type: "image/png", dataUrl: "marked.png", storageKey: "local:marked", temporary: true }]);
    assert.equal(h.uploads[0][0], payload.markedDataUrl);
    assert.equal(h.uploads[0][1].token, "owner");
    assert.equal(h.target().open, false);
    assert.deepEqual(originalLog, before);
});

test("当前已切用户渠道时，系统渠道历史重绘仍用系统模型集合校验并提交", async () => {
    const h = submissionScope();
    const current = { ...config, channelMode: "local", models: ["local-only"] };
    h.scope.effectiveConfig = current;
    h.scope.buildRequestSnapshot = callback("buildRequestSnapshot", {
        effectiveConfig: current, config: current, model: "local-only", token: "owner",
        generationCount: 5, references: [], prompt: "",
        isAiConfigReady: (value, model) => value.channelMode === "remote" && value.models.includes(model),
        openConfigDialog: assert.fail,
        resolveImageChannelId: callback("resolveImageChannelId"),
        imageOutputCapabilityForConfig: () => ({}),
        resolveImageOutputFormat: () => ({ format: "auto", fellBack: false }),
        normalizeImageOutputFormat: () => "auto",
        buildGenerationLogConfig: (value) => value,
        message: { error: assert.fail, warning: assert.fail },
    });
    await callback("submitMaskEdit", h.scope)(payload);
    assert.equal(h.errors.length, 0);
    assert.equal(h.submissions.length, 1);
    assert.equal(h.submissions[0].requestConfig.channelMode, "remote");
    assert.equal(h.submissions[0].requestConfig.imageChannelId, "original-channel");
});

test("上传或创建失败保留重绘对话框，并通过 message.error 提示", async () => {
    for (const overrides of [
        { uploadImage: async () => { throw new Error("上传失败"); } },
        { submitGenerationBatch: async () => { throw new Error("创建失败"); } },
        { submitGenerationBatch: async () => false },
    ]) {
        const h = submissionScope(overrides);
        await callback("submitMaskEdit", h.scope)(payload);
        assert.equal(h.target().open, true);
        assert.equal(h.errors.length, 1);
        assert.match(h.errors[0], /失败/);
    }
});

test("重绘上传期间切号不能替新账号创建任务", async () => {
    let owner = "owner";
    const h = submissionScope({
        useUserStore: { getState: () => ({ token: owner }) },
        uploadImage: async () => { owner = "another-owner"; return { mimeType: "image/png", url: "marked.png", storageKey: "local:marked" }; },
    });
    await callback("submitMaskEdit", h.scope)(payload);
    assert.equal(h.submissions.length, 0);
    assert.equal(h.target().open, true);
    assert.equal(h.errors.length, 0, "切号后不向新账号显示旧任务错误");
    const stale = submissionScope({ useUserStore: { getState: () => ({ token: "another-owner" }) } });
    await callback("submitMaskEdit", stale.scope)(payload);
    assert.equal(stale.uploads.length, 0);
    assert.equal(stale.submissions.length, 0);
});

test("重绘复用持久任务链路，新增日志带当前分类与账号，原日志不被覆盖", async () => {
    let saved = [plain(originalLog)];
    const requests = [];
    const accountWrites = [];
    const h = submissionScope();
    let sequence = 0;
    const scope = {
        ...h.scope, activeResultCategoryId: "active-category", Date, nanoid: () => `new-${++sequence}`,
        setPreviewLog: () => {}, setResults: () => {}, setNow: () => {},
        mergePendingLogResults: () => [], updateResultByLogId: () => [],
        buildLog: callback("buildLog", { nanoid: () => `new-${++sequence}`, formatLogTime: () => "time" }),
        imageLogTaskId: (log) => log.task.id,
        createCanvasImageTask: async (...args) => { requests.push(args); return { id: "new-task", status: "queued" }; },
        accountHistorySyncEnabledRef: { current: true }, saveLogChainRef: { current: Promise.resolve() },
        readStoredLogs: async () => saved, setLogs: (logs) => { saved = plain(logs); },
        categories: [{ id: "active-category", name: "当前分类" }],
        imageLogIdentityKeys: (log) => [log.id], dedupeGenerationLogs: (logs) => logs,
        serializeLog: plain, logStore: { setItem: async () => {}, removeItem: assert.fail },
        upsertImageGenerationLogs: async (...args) => { accountWrites.push(plain(args)); },
        readStoredImageCategories: async () => ({ categories: [], deletedCategories: [] }),
        mergeImageCategories: (categories) => ({ categories, deletedCategories: [] }),
        syncedImageCategoriesRef: { current: { token: "owner", state: {} } },
        sameImageCategoryState: () => true,
        message: { success: () => {}, warning: assert.fail },
    };
    scope.persistImageHistory = callback("persistImageHistory", scope);
    scope.saveLog = callback("saveLog", scope);
    scope.createPersistentImageTask = callback("createPersistentImageTask", scope);
    h.scope.submitGenerationBatch = callback("submitGenerationBatch", {
        token: "owner", useUserStore: h.scope.useUserStore,
        usesBackendImageTasks: () => true,
        submitPersistentGenerationBatch: callback("submitPersistentGenerationBatch", scope),
    });
    await callback("submitMaskEdit", h.scope)(payload);
    assert.equal(requests.length, 1);
    assert.equal(requests[0][3].source, "image-workbench");
    assert.equal(accountWrites.length, 1);
    assert.equal(accountWrites[0][0], "owner");
    assert.equal(saved.length, 2);
    const next = saved.find((log) => log.id !== originalLog.id);
    assert.deepEqual(next.categoryIds, ["active-category"]);
    assert.equal(next.references[0].temporary, true);
    assert.deepEqual(saved.find((log) => log.id === originalLog.id), originalLog);
});

test("本地直连提交保持单图成功或失败日志及当前分类，并返回真实提交状态", async () => {
    for (const succeeds of [true, false]) {
        const saved = [];
        const errors = [];
        const h = submissionScope();
        const submit = callback("submitGenerationBatch", {
            token: "owner", useUserStore: h.scope.useUserStore,
            usesBackendImageTasks: () => false, activeResultCategoryId: "active-category",
            setPreviewLog: () => {}, setResults: () => {}, setNow: () => {},
            nanoid: () => "new-local-task", createPendingResult: (id) => ({ id }),
            performance: { now: () => 1 }, buildLog: (log) => log,
            runGenerationTask: async () => { if (!succeeds) throw new Error("直连失败"); return { ...image, id: "new-local-image" }; },
            saveLog: async (log) => { saved.push(plain(log)); },
            errorMessage: (error) => error.message, errorDetail: (error) => error.message,
            message: { success: () => {}, error: (value) => errors.push(value) },
        });
        const snapshot = h.scope.buildRequestSnapshot({ promptText: "test", taskCount: 1, configOverride: { channelMode: "local" } });
        assert.equal(await submit(snapshot), succeeds);
        assert.equal(saved.length, 1);
        assert.equal(saved[0].status, succeeds ? "成功" : "失败");
        assert.deepEqual(saved[0].categoryIds, ["active-category"]);
        assert.equal(errors.length, succeeds ? 0 : 1);
    }
});

test("持久任务提交将全部创建失败反馈给重绘调用方", async () => {
    const h = submissionScope();
    const submit = callback("submitPersistentGenerationBatch", {
        ...h.scope, activeResultCategoryId: null, nanoid: () => "new-task",
        setPreviewLog: () => {}, setResults: () => {}, setNow: () => {},
        buildLog: (log) => log, mergePendingLogResults: () => [],
        createPersistentImageTask: async () => { throw new Error("创建失败"); },
        message: { success: () => {}, warning: () => {} },
    });
    const snapshot = h.scope.buildRequestSnapshot({ promptText: "test", taskCount: 1, configOverride: {} });
    assert.equal(await submit(snapshot), false);
});

function component(name, props, extra = {}) {
    const tags = {};
    function visit(node) {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) tags[node.tagName.text] = node.tagName.text;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    return callback(name, {
        ...tags, jsx: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: "Fragment",
        useState: (value) => [typeof value === "function" ? value() : value, () => {}],
        useRef: () => ({ current: null }), useEffect: () => {},
        App: { useApp: () => ({ message: {} }) },
        formatLogTime: () => "time", formatDuration: () => "time", formatBytes: () => "10B",
        imageResultIdentityKeys: (value) => [value.id], imageLogIdentityKeys: (value) => [value.id],
        selectedImageLogImages: () => [], Typography: { Paragraph: "Paragraph" },
        ...extra,
    })(props);
}
function find(tree, predicate) {
    if (Array.isArray(tree)) return tree.flatMap((item) => find(item, predicate));
    if (!tree || typeof tree !== "object") return [];
    return [...(predicate(tree) ? [tree] : []), ...find(tree.children, predicate)];
}

test("ResultsPanel 把日志和选中图片传给重绘回调，历史按钮可实际点击", () => {
    const calls = [];
    const panel = component("ResultsPanel", {
        logs: [originalLog], results: [], categories: [], selectedLogIds: [], syncingImageIds: [],
        resultViewMode: "all", activeCategoryId: null, pendingCount: 0, now: 0,
        onMaskEdit: (...args) => calls.push(args),
    });
    const card = find(panel, (node) => node.type === "HistoryLogCard")[0];
    assert.ok(card, "应渲染历史结果");
    const rendered = component("HistoryLogCard", card.props);
    const button = find(rendered, (node) => node.type === "Button" && node.children.some((value) => typeof value === "string" && value.trim() === "局部重绘"))[0];
    assert.ok(button, "历史结果必须提供可点击的局部重绘按钮");
    button.props.onClick();
    assert.deepEqual(calls, [[originalLog, image]]);
    const empty = component("HistoryLogCard", { ...card.props, log: { ...originalLog, images: [] } });
    assert.equal(find(empty, (node) => node.type === "Button" && node.children.some((value) => value === "局部重绘")).length, 0);
});

test("实时结果同样可重绘；侧栏和底部布局均接线共享弹窗", () => {
    const calls = [];
    const result = { ...originalLog, id: "live-result", status: "success", image };
    const panel = component("ResultsPanel", {
        logs: [], results: [result], categories: [], selectedLogIds: [], syncingImageIds: [],
        resultViewMode: "all", activeCategoryId: null, pendingCount: 0, now: 0,
        onMaskEdit: (...args) => calls.push(args),
    });
    const card = find(panel, (node) => node.type === "ResultImageCard")[0];
    const rendered = component("ResultImageCard", card.props);
    const button = find(rendered, (node) => node.type === "Button" && node.props.title === "局部重绘")[0];
    assert.ok(button, "实时结果必须提供局部重绘按钮");
    button.props.onClick();
    assert.deepEqual(calls, [[result, image]]);
    assert.equal((source.match(/onMaskEdit=\{openMaskEdit\}/g) || []).length, 2);
    assert.match(source, /<CanvasNodeMaskEditDialog[\s\S]*?onConfirm=\{submitMaskEdit\}/);
});

function deferred() {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

const dialogSource = readFileSync(new URL("../app/(user)/canvas/components/canvas-node-mask-edit-dialog.tsx", import.meta.url), "utf8");
const dialogAst = ts.createSourceFile("dialog.tsx", dialogSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

test("重绘对话框同帧双击与挂起期间不可重入，等 onConfirm 完成才释放 loading", async () => {
    const pending = deferred();
    const started = deferred();
    const loading = [];
    let requests = 0;
    const submittingRef = { current: false };
    const submit = callback("submit", {
        prompt: "修改", dataUrl: image.dataUrl, model: "model", channelId: "channel",
        maskCanvasRef: { current: {} }, canvasHasPaint: () => true, submittingRef,
        setError: assert.fail, setSubmitting: (value) => loading.push(value),
        buildMarkedReference: async () => payload.markedDataUrl,
        onConfirm: () => { requests++; started.resolve(); return pending.promise; },
    }, dialogAst);
    const first = submit();
    const second = submit();
    await started.promise;
    try {
        assert.equal(requests, 1, "同步防重入必须阻止同帧第二次付费请求");
        assert.equal(loading.at(-1), true, "异步 onConfirm 未完成时必须保持 loading");
        await submit();
        assert.equal(requests, 1, "挂起期间再次点击不能重复创建任务");
    } finally {
        pending.resolve();
        await Promise.all([first, second]);
    }
    assert.equal(loading.at(-1), false);
    assert.equal(submittingRef.current, false);
});

test("异步 onConfirm 拒绝时仍释放同步锁与 loading，允许之后重试", async () => {
    let requests = 0;
    const loading = [];
    const errors = [];
    const submittingRef = { current: false };
    const submit = callback("submit", {
        prompt: "修改", dataUrl: image.dataUrl, model: "model", channelId: "channel",
        maskCanvasRef: { current: {} }, canvasHasPaint: () => true, submittingRef,
        setError: (value) => errors.push(value), setSubmitting: (value) => loading.push(value),
        buildMarkedReference: async () => payload.markedDataUrl,
        onConfirm: () => { requests++; const rejected = Promise.reject(new Error("提交失败")); void rejected.catch(() => {}); return rejected; },
    }, dialogAst);
    await submit();
    assert.equal(errors.length, 1);
    assert.equal(submittingRef.current, false);
    assert.equal(loading.at(-1), false);
    await submit();
    assert.equal(requests, 2);
});

test("普通持久任务创建中切号，成功或失败响应都不保存日志与结果", async () => {
    for (const rejects of [false, true]) {
        let owner = "owner";
        const pending = deferred();
        const writes = [];
        const start = callback("createPersistentImageTask", {
            token: "owner", useUserStore: { getState: () => ({ token: owner }) },
            createCanvasImageTask: () => pending.promise, imageLogTaskId: () => "pending-task",
            saveLog: async (log) => writes.push(["log", log]),
            setResults: (value) => writes.push(["result", value]),
            updateResultByLogId: () => [], errorMessage: (error) => error.message, errorDetail: (error) => error.message,
        });
        const running = start({ ...originalLog, createdAt: 1 }, { workflowRef: null, requestConfig: config, references: [] }, 0, 1, "owner");
        owner = "another-owner";
        if (rejects) pending.reject(new Error("上游失败")); else pending.resolve({ id: "paid-task", status: "queued" });
        const outcome = await Promise.allSettled([running]);
        assert.equal(writes.length, 0, "旧账号创建响应不得写入新账号页面或日志");
        assert.equal(outcome[0].status, "rejected");
    }
});

test("持久任务批次发起前与每个后续任务前检查 owner，切号后不再创建付费任务", async () => {
    let owner = "owner";
    const requests = [];
    const scope = {
        token: "owner", useUserStore: { getState: () => ({ token: owner }) },
        activeResultCategoryId: null, nanoid: () => `new-${requests.length}`,
        setPreviewLog: () => {}, setResults: () => {}, setNow: () => {},
        buildLog: (value) => value, mergePendingLogResults: () => [],
        imageLogTaskId: () => "pending", saveLog: assert.fail,
        createCanvasImageTask: async () => { requests.push(owner); owner = "another-owner"; return { id: "paid-task" }; },
        message: { success: assert.fail, warning: assert.fail },
    };
    scope.createPersistentImageTask = callback("createPersistentImageTask", scope);
    const submit = callback("submitPersistentGenerationBatch", scope);
    const snapshot = { requestConfig: config, displayConfig: { ...config, count: "2" }, references: [] };
    assert.equal(await submit(snapshot), false);
    assert.deepEqual(requests, ["owner"]);
    requests.length = 0;
    assert.equal(await submit(snapshot), false);
    assert.equal(requests.length, 0, "失效旧回调不得按新账号创建任务");
});

test("直连生成或读取图片元数据期间切号，成功和错误都不写日志/结果/通知", async () => {
    for (const stage of ["request-success", "request-failure", "metadata"]) {
        let owner = "";
        const pending = deferred();
        const writes = [];
        const scope = {
            token: "", useUserStore: { getState: () => ({ token: owner }) }, usesBackendImageTasks: () => false,
            activeResultCategoryId: null, nanoid: () => "new-direct-task",
            setPreviewLog: () => {}, setResults: (value) => writes.push(["result", value]), setNow: () => {},
            createPendingResult: (id) => ({ id }), buildLog: (log) => log,
            updateResult: (value) => value, performance: { now: () => 1 },
            requestGeneration: () => stage === "metadata" ? Promise.resolve([{ ...image, width: 0 }]) : pending.promise,
            readImageMeta: () => pending.promise,
            saveLog: async (log) => writes.push(["log", log]),
            errorMessage: (error) => error.message, errorDetail: (error) => error.message,
            message: { success: () => writes.push(["success"]), error: () => writes.push(["error"]) },
        };
        scope.runGenerationTask = callback("runGenerationTask", scope);
        const submit = callback("submitGenerationBatch", scope);
        const running = submit({ requestConfig: { channelMode: "local" }, displayConfig: { count: "1" }, references: [], text: "生成" });
        await Promise.resolve();
        writes.length = 0;
        owner = "new-account";
        if (stage === "request-failure") pending.reject(new Error("上游失败"));
        else pending.resolve(stage === "metadata" ? { width: 100, height: 100, mimeType: "image/png" } : [{ ...image, mimeType: "image/png" }]);
        assert.equal(await running, false);
        assert.deepEqual(writes, [], "旧游客/账号任务完成后不得污染新账号状态");
    }
});
