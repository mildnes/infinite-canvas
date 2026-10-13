import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { beginTaskRun, currentTaskRun, isStoppedTask } from "../../../lib/generation-task-run.ts";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("video.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function walk(node) { nodes.push(node); ts.forEachChild(node, walk); }
walk(ast);
const compile = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const callback = (name) => nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === name).initializer.getText(ast);

test("视频工作台真实停止回调：停止中禁重复、失败重试、确认取消并中止旧 run", async () => {
    const log = { id: "log", status: "生成中", createdAt: Date.now(), task: { id: "task" } };
    const state = { logs: [log], results: [{ id: "log", status: "pending" }] };
    const runs = new Map();
    const run = beginTaskRun(runs, "log", "video", "task", "token");
    let calls = 0;
    const scope = {
        taskRunsRef: { current: runs }, beginTaskRun, isStoppedTask, videoLogTaskId: () => "task",
        useUserStore: { getState: () => ({ token: "token" }) },
        setLogs: (update) => { state.logs = update(state.logs); }, setResults: (update) => { state.results = update(state.results); },
        updateResultByLogId: (results, id, update) => results.map((item) => item.id === id ? { ...item, ...update } : item),
        finalizeGenerationLog: async (next, active) => { if (active()) state.logs = [next]; },
        stopCanvasTask: async () => { calls++; if (calls === 1) throw Error("offline"); return { status: "cancelled" }; },
        message: { warning() {}, success() {}, error() {} },
    };
    const stop = vm.runInNewContext(compile("(" + callback("stopVideoLog") + ")"), scope);
    await stop(log);
    assert.equal(state.logs[0].stopState, "failed");
    assert.equal(run.stopping, false);
    await stop(state.logs[0]);
    assert.equal(state.logs[0].status, "已停止");
    assert.equal(state.results[0].status, "cancelled");
    assert.equal(currentTaskRun(runs, "log", run, "token"), false);
    assert.equal(calls, 2);
});

test("视频历史合并不允许旧 processing 回包复活终态", () => {
    const definition = nodes.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "mergeBackendTaskIntoLog");
    const merge = vm.runInNewContext(compile("(" + definition.getText(ast) + ")"));
    for (const status of ["已停止", "成功", "失败"]) {
        const existing = { id: "log", status, config: {} };
        assert.equal(merge(existing, { status: "生成中", config: {} }, { status: "processing" }), existing);
    }
});

test("两个工作台布局均接停止动作；重新生成仍生成 fresh clientTaskId", () => {
    assert.equal((source.match(/onStopLog=\{/g) || []).length, 2);
    assert.equal((source.match(/onStopResult=\{/g) || []).length, 2);
    assert.match(source, /停止中|taskStopAction/);
    assert.match(callback("submitGenerationSnapshot"), /client_video_task_.*nanoid/);
    assert.match(callback("retryResult"), /submitGenerationSnapshot/);
});
