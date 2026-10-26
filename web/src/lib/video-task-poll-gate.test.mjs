import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/(user)/video/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("video.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "shouldPollVideoTasks");

function loadGate() {
    assert.ok(declaration, "视频页面应提供 shouldPollVideoTasks 纯门控");
    const code = ts.transpileModule(`(${declaration.getText(ast).replace(/^export\s+/, "")})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
    }).outputText;
    return vm.runInNewContext(code);
}

test("停止中的视频任务保持轮询直到终态", () => {
    const shouldPoll = loadGate();
    const actual = shouldPoll({
        pendingCount: 0,
        pendingLogCount: 0,
        results: [{ id: "log", status: "pending", stopState: "stopping" }],
    });
    assert.equal(actual, true);
});

test("没有进行中或停止中任务时门控关闭", () => {
    const shouldPoll = loadGate();
    assert.equal(shouldPoll({ pendingCount: 0, pendingLogCount: 0, results: [] }), false);
    assert.equal(shouldPoll({ pendingCount: 0, pendingLogCount: 0, results: [{ id: "done", status: "success" }] }), false);
    assert.equal(shouldPoll({ pendingCount: 0, pendingLogCount: 0, results: [{ id: "failed-stop", status: "pending", stopState: "failed" }] }), false);
});

test("页面轮询 effect 使用统一门控并在完成终态清理结果", () => {
    const effect = findNamedEffect("hasPendingTasks");
    assert.match(effect, /if \(!hasPendingTasks\) return;/);
    assert.match(effect, /\[hasPendingTasks, token, userId\]/);
    assert.doesNotMatch(effect, /if \(!pendingLogCount\) return;/);
    assert.match(source, /const hasPendingTasks = shouldPollVideoTasks\(\{ pendingCount, pendingLogCount, results \}\);/);
    assert.match(source, /setResults\(\(value\) => \(active\(\) \? value\.filter\(\(item\) => item\.taskLogId !== logId && item\.id !== logId\) : value\)\);/);
});

test("停止提交期间的终态轮询仍可清理已结算的结果", () => {
    const poll = findCallback("pollPendingLogOnce");
    const filterCode = poll.match(/value\.filter\(\(item\) => item\.taskLogId !== logId && item\.id !== logId\)/)?.[0];
    assert.ok(filterCode, "完成轮询应按 taskLogId 与 id 清理结果");
    const filter = Function("value", "logId", `return value.filter(${filterCode.match(/filter\((.*)\)/)[1]});`);
    const results = [
        { id: "log", status: "pending", stopState: "stopping" },
        { id: "other", status: "pending" },
    ];
    assert.deepEqual(filter(results, "log"), [{ id: "other", status: "pending" }]);
    assert.match(poll, /const active = \(\) => !context\.signal\.aborted && currentTaskRun\(taskRunsRef\.current, log\.id, run, currentTaskOwnerId\(\)\);/);
});

function findNamedEffect(marker) {
    let effect = "";
    function walk(node) {
        if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.getText(ast).includes(marker)) {
            effect = node.getText(ast);
        }
        ts.forEachChild(node, walk);
    }
    walk(ast);
    assert.ok(effect, "应存在使用统一轮询门控的 effect");
    return effect;
}

function findCallback(name) {
    let callback = "";
    function walk(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) callback = node.initializer.getText(ast);
        ts.forEachChild(node, walk);
    }
    walk(ast);
    assert.ok(callback, `应存在回调 ${name}`);
    return callback;
}
