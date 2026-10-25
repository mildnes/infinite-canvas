import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const runSource = readFileSync(new URL("./generation-task-run.ts", import.meta.url), "utf8");
const code = ts.transpileModule(runSource, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const polling = {};
vm.runInNewContext(code, { exports: polling, AbortController, DOMException, Error, setTimeout, clearTimeout });

test("404 stops canvas polling immediately; missing legacy task envelopes also stop", () => {
    for (const error of [{ status: 404 }, { response: { status: 404 } }, new Error("图片任务不存在")]) {
        const state = polling.recordCanvasTaskPollError("original-task", error, undefined, 100);
        assert.equal(state.stopped, true);
        assert.equal(state.errorCount, 1);
        assert.match(state.errorDetails, /任务记录不存在/);
        assert.equal(polling.canPollCanvasTask("original-task", state, 100000), false);
    }
});

test("canvas polling backs off consecutive failures and stops at a bounded limit", () => {
    let state;
    let now = 100;
    let previousDelay = 0;
    for (let count = 1; count <= polling.CANVAS_TASK_POLL_ERROR_LIMIT; count++) {
        state = polling.recordCanvasTaskPollError("task", new Error("网络断开"), state, now);
        assert.equal(state.errorCount, count);
        assert.equal(state.stopped, count === polling.CANVAS_TASK_POLL_ERROR_LIMIT);
        if (!state.stopped) {
            assert.ok(state.nextPollAt - now >= previousDelay);
            previousDelay = state.nextPollAt - now;
            assert.equal(polling.canPollCanvasTask("task", state, state.nextPollAt - 1), false);
            assert.equal(polling.canPollCanvasTask("task", state, state.nextPollAt), true);
            now = state.nextPollAt;
        }
    }
    assert.equal(state.stopped, true);
    assert.match(state.errorDetails, /重新查询/);
});

test("a new task and a successful poll reset consecutive errors", () => {
    const failed = polling.recordCanvasTaskPollError("old-task", new Error("offline"), undefined, 10);
    assert.equal(polling.canPollCanvasTask("new-task", failed, 10), true);
    assert.equal(polling.recordCanvasTaskPollError("new-task", new Error("offline"), failed, 10).errorCount, 1);
    assert.equal(polling.recordCanvasTaskPollError("old-task", new Error("offline"), undefined, 10).errorCount, 1);
});

test("recoverable canvas polling retry only looks up the original task", () => {
    assert.equal(polling.canvasTaskRetryMode("error", true, "original-task"), "lookup");
    assert.equal(polling.canvasTaskRetryMode("loading", false, "original-task"), "lookup");
    assert.equal(polling.canvasTaskRetryMode("error", false, "confirmed-failed-task"), "generate");
    assert.equal(polling.canvasTaskRetryMode("cancelled", false, "cancelled-task"), "generate");
});

test("a blackhole canvas poll aborts and reports a retryable timeout", async () => {
    let requestSignal;
    await assert.rejects(polling.pollCanvasTaskRequest((signal) => {
        requestSignal = signal;
        return new Promise(() => {});
    }, undefined, 10), /任务查询超时/);
    assert.equal(requestSignal.aborted, true);
});

test("canvas polling preserves cancellation and settles successful requests", async () => {
    const owner = new AbortController();
    const result = { id: "same-task", status: "completed" };
    assert.equal(await polling.pollCanvasTaskRequest(async () => result, owner.signal, 100), result);
    owner.abort();
    await assert.rejects(polling.pollCanvasTaskRequest(async () => result, owner.signal, 100), { name: "AbortError" });
});

test("owner cancellation aborts an in-flight blackhole task poll immediately", async () => {
    const owner = new AbortController();
    let requestSignal;
    const pending = polling.pollCanvasTaskRequest((signal) => { requestSignal = signal; return new Promise(() => {}); }, owner.signal, 1000);
    await new Promise((resolve) => setImmediate(resolve));
    owner.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(requestSignal.aborted, true);
});

function queryTask(filename, functionName) {
    const source = readFileSync(new URL(filename, import.meta.url), "utf8");
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === functionName);
    const queryCode = ts.transpileModule("(" + declaration.getText(ast).replace(/^export\s+/, "") + ")", { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
    return vm.runInNewContext(queryCode, {
        useUserStore: { getState: () => ({ token: "owner" }) },
        captureImageRequestOwner: () => ({}),
        fetch: async () => ({ ok: false, status: 404 }),
        fetchErrorDetail: async () => ({ message: "图片任务不存在" }),
        readFetchError: async () => "音频任务不存在",
        ImageRequestError: Error,
        Error,
    });
}

test("image and audio task lookup preserve HTTP 404 for immediate failure", async () => {
    for (const [filename, name] of [["../services/api/image.ts", "pollCanvasImageTaskStatus"], ["../services/api/audio.ts", "pollCanvasAudioTaskStatus"]]) {
        await assert.rejects(queryTask(filename, name)("original-task"), (error) => error.status === 404);
    }
});

const pageSource = readFileSync(new URL("../app/(user)/canvas/[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const pageAst = ts.createSourceFile("page.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let pollingEffect;
function findPollingEffect(node) {
    if (ts.isCallExpression(node) && node.expression.getText(pageAst) === "useEffect" && node.arguments[0]?.getText(pageAst).includes("const pollCanvasTasks =")) pollingEffect = node.arguments[0];
    ts.forEachChild(node, findPollingEffect);
}
findPollingEffect(pageAst);
const effectCode = ts.transpileModule("(" + pollingEffect.getText(pageAst) + ")", { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

function pageCallback(name, globals) {
    let declaration;
    function find(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(pageAst) === name) declaration = node.initializer.arguments[0];
        ts.forEachChild(node, find);
    }
    find(pageAst);
    const callback = ts.transpileModule("(" + declaration.getText(pageAst) + ")", { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    return vm.runInNewContext(callback, globals);
}

for (const [kind, workflow] of [["image", false], ["audio", false], ["video", false], ["image", true], ["audio", true], ["video", true]]) {
    test(`the actual ${workflow ? "workflow " : ""}${kind} retry queries the existing task without submitting generation`, async () => {
        const id = "client_" + kind + "_task_original";
        let nodes = [{ id: "node", type: kind, width: 200, height: 200, metadata: { status: "error", taskPollError: true, [kind + "TaskId"]: id, ...(workflow ? { workflowRef: {} } : {}) } }];
        const calls = [];
        const run = { id: "retry", taskId: id, controller: new AbortController() };
        let missing = false;
        const readTask = async (taskId) => {
            calls.push(taskId);
            if (missing) throw Object.assign(new Error("任务不存在"), { status: 404 });
            return { id: taskId, status: "completed", url: "/api/files/result/content" };
        };
        const apply = (items, nodeId, task) => items.map((item) => item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: "success", content: task.url } } : item);
        const globals = {
            ...polling, Error,
            canvasRecoverableTaskId: (node) => node.metadata[kind + "TaskId"] || "",
            CanvasNodeType: { Video: "video", Audio: "audio" },
            NODE_STATUS_LOADING: "loading", NODE_STATUS_ERROR: "error",
            taskPollingStateRef: { current: new Map() },
            nodesRef: { get current() { return nodes; } },
            pollingVideoNodeIdsRef: { current: new Set() }, pollingImageNodeIdsRef: { current: new Set() }, pollingAudioNodeIdsRef: { current: new Set() },
            startNodeTaskRun: () => run, nodeRunActive: () => true, guardNodeTaskResponse: () => {},
            effectiveConfig: {}, buildGenerationConfig: () => ({}),
            canvasVideoTaskFromMetadata: (metadata) => ({ id: metadata.videoTaskId }),
            canWriteCanvas: () => true, requireCanvasWriter: () => true,
            pollCanvasImageTaskStatus: readTask, pollCanvasAudioTaskStatus: readTask,
            pollVideoGenerationTaskStatus: (_config, task) => readTask(task.id),
            useUserStore: { getState: () => ({ token: "owner" }) },
            getWorkflowTask: (_token, taskId) => readTask(taskId),
            workflowVideoTask: (task) => task, workflowAudioTask: (task) => task, workflowImageTask: (task) => task,
            applyCanvasVideoTaskUpdate: apply, applyCanvasAudioTaskUpdate: apply, applyCanvasImageTaskUpdate: apply,
            setNodes: (update) => { nodes = update(nodes); }, setConnections: () => {}, setRunningNodeId: () => {},
            message: { error: () => {} },
            findRetrySourceNode: () => { throw new Error("poll recovery must not enter generation"); },
        };
        globals.resumeNodeTaskPolling = pageCallback("resumeNodeTaskPolling", globals);
        const retry = pageCallback("handleRetryNode", globals);
        await retry(nodes[0]);
        assert.deepEqual(calls, [id]);
        assert.equal(nodes[0].metadata.status, "success");
        assert.equal(nodes[0].metadata.taskPollError, undefined);
        assert.equal(nodes[0].metadata[kind + "TaskId"], id);
        nodes[0] = { ...nodes[0], metadata: { ...nodes[0].metadata, status: "error", taskPollError: true, content: undefined } };
        missing = true;
        await retry(nodes[0]);
        await retry(nodes[0]);
        assert.deepEqual(calls, [id, id, id]);
        assert.equal(nodes[0].metadata.status, "error");
        assert.equal(nodes[0].metadata.taskPollError, true);
        assert.equal(nodes[0].metadata[kind + "TaskId"], id);
    });
}

for (const [kind, workflow] of [["image", false], ["audio", false], ["video", false], ["image", true], ["audio", true], ["video", true]]) {
    test(`the actual canvas ${workflow ? "workflow " : ""}${kind} polling effect stops missing tasks and preserves the task id`, async () => {
        const id = "client_" + kind + "_task_original";
        let nodes = [{ id: "node", type: kind, width: 200, height: 200, metadata: { status: "loading", [kind + "TaskId"]: id, ...(workflow ? { workflowRef: {} } : {}) } }];
        const run = { id: "run", taskId: id, controller: new AbortController() };
        const state = new Map();
        const effect = vm.runInNewContext(effectCode, {
            ...polling,
            projectLoaded: true,
            nodesRef: { get current() { return nodes; } },
            pollingVideoNodeIdsRef: { current: new Set() }, pollingImageNodeIdsRef: { current: new Set() }, pollingAudioNodeIdsRef: { current: new Set() },
            taskPollingStateRef: { current: state },
            canWriteCanvas: () => true,
            nodeTaskRunsRef: { current: new Map([["node", run]]) },
            startNodeTaskRun: () => run,
            nodeRunActive: () => true,
            CanvasNodeType: { Video: "video", Audio: "audio" },
            NODE_STATUS_LOADING: "loading", NODE_STATUS_ERROR: "error",
            canvasVideoTaskId: (metadata) => metadata?.videoTaskId,
            canvasVideoTaskFromMetadata: (metadata) => ({ id: metadata.videoTaskId }),
            isCanvasImageNodeType: (type) => type === "image",
            effectiveConfig: {}, buildGenerationConfig: () => ({}), isAiConfigReady: () => false,
            pollCanvasImageTaskStatus: async () => { throw Object.assign(new Error("missing"), { status: 404 }); },
            pollCanvasAudioTaskStatus: async () => { throw Object.assign(new Error("missing"), { status: 404 }); },
            pollVideoGenerationTaskStatus: async () => { throw { response: { status: 404 } }; },
            useUserStore: { getState: () => ({ token: "owner" }) },
            getWorkflowTask: async () => { throw Object.assign(new Error("missing"), { status: 404 }); },
            workflowVideoTask: (task) => task, workflowAudioTask: (task) => task, workflowImageTask: (task) => task,
            setNodes: (update) => { nodes = update(nodes); }, setConnections: () => {},
            reportNodeTaskPollError: (node, _run, error) => {
                const outcome = polling.recordCanvasTaskPollError(id, error);
                state.set(node.id, outcome);
                if (outcome.stopped) nodes = nodes.map((item) => ({ ...item, metadata: { ...item.metadata, status: "error", taskPollError: true, errorDetails: outcome.errorDetails } }));
            },
            window: { setInterval: () => 1, clearInterval: () => {} }, VIDEO_POLL_INTERVAL_MS: 5000,
        });
        const cleanup = effect();
        await new Promise((resolve) => setImmediate(resolve));
        cleanup();
        assert.equal(nodes[0].metadata.status, "error");
        assert.equal(nodes[0].metadata[kind + "TaskId"], id);
        assert.equal(nodes[0].metadata.taskPollError, true);
    });
}
