import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const pagePath = "web/src/app/(user)/canvas/[id]/canvas-client-page.tsx";
const baseline = process.env.CANVAS_TASK_BASELINE;

function sourceAt(path) {
    if (baseline) {
        try {
            return execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" });
        } catch {
            return "";
        }
    }
    return readFileSync(new URL(`../app/(user)/canvas/[id]/canvas-client-page.tsx`, import.meta.url), "utf8");
}

function extractCallbacks(source) {
    const pageAst = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const wanted = new Map();
    function visit(node) {
        if (ts.isVariableDeclaration(node) && (node.name.getText(pageAst) === "deleteNodes" || node.name.getText(pageAst) === "executeCanvasAgentAction")) {
            const initializer = node.initializer;
            if (initializer && ts.isCallExpression(initializer)) {
                const callback = initializer.arguments[0];
                if (callback) wanted.set(node.name.getText(pageAst), callback.getText(pageAst));
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(pageAst);
    assert.ok(wanted.has("deleteNodes"), "页面应有 deleteNodes 实际回调");
    assert.ok(wanted.has("executeCanvasAgentAction"), "页面应有 executeCanvasAgentAction 实际回调");
    const compile = (text) => ts.transpileModule(`(${text})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
    }).outputText;
    return {
        deleteNodes: compile(wanted.get("deleteNodes")),
        executeCanvasAgentAction: compile(wanted.get("executeCanvasAgentAction")),
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function createHarness(sourceOrOptions, maybeOptions = {}) {
    const source = typeof sourceOrOptions === "string" ? sourceOrOptions : undefined;
    const { deleteResult, failDelete = false } = typeof sourceOrOptions === "string" ? maybeOptions : (sourceOrOptions || {});
    const callbacks = extractCallbacks(source || sourceAt(pagePath));
    let nodes = [
        { id: "root", metadata: { isBatchRoot: true, batchChildIds: ["child-1", "child-2"], primaryImageId: "child-1" } },
        { id: "child-1", metadata: {} },
        { id: "child-2", metadata: {} },
        { id: "other", metadata: {} },
    ];
    let deleteTaskResolve;
    let taskDeleteCalls = [];
    let callbackDeleteCalls = [];
    let chatSessions = [];
    const taskDelete = new Promise((resolve) => { deleteTaskResolve = resolve; });
    const globals = {
        AbortController,
        DOMException,
        Error,
        Promise,
        Set,
        Map,
        Date,
        Math,
        console,
        requireCanvasWriter: () => true,
        message: { error() {}, warning() {} },
        projectId: "project",
        currentProject: { title: "测试画板" },
        messageReferenceNodeIds: [],
        useCanvasStore: { getState: () => ({ projects: [{ id: "project", autoTitlePending: false }] }) },
        nodesRef: { get current() { return nodes; }, set current(value) { nodes = value; } },
        connectionsRef: { current: [] },
        selectedNodeIdsRef: { current: new Set() },
        historyRef: { current: [] },
        lastHistoryRef: { current: [] },
        chatSessions,
        setChatSessions: (update) => { chatSessions = typeof update === "function" ? update(chatSessions) : update; },
        setNodes: (update) => { nodes = typeof update === "function" ? update(nodes) : update; },
        setConnections: () => {},
        setSelectedNodeIds: () => {},
        setSelectedConnectionId: () => {},
        setHoveredNodeId: () => {},
        setToolbarNodeId: () => {},
        setDialogNodeId: () => {},
        setInfoNodeId: () => {},
        setCropNodeId: () => {},
        setMaskEditNodeId: () => {},
        setAngleNodeId: () => {},
        setPreviewNodeId: () => {},
        setRunningNodeId: () => {},
        setReferencePickerNodeId: () => {},
        setContextMenu: () => {},
        collectImageStorageKeys: () => new Set(),
        useAssetStore: { getState: () => ({ assets: [] }) },
        deleteStoredImages: async () => {},
        cleanupCanvasFiles: () => {},
        updateProject: () => {},
        deleteCanvasTaskRecords: async (ids) => {
            taskDeleteCalls = ids;
            if (failDelete) throw new Error("删除任务记录失败");
            await taskDelete;
        },
    };
    const deleteNodes = vm.runInNewContext(callbacks.deleteNodes, globals);
    const executeCanvasAgentAction = vm.runInNewContext(callbacks.executeCanvasAgentAction, {
        ...globals,
        deleteNodes: async (ids) => {
            callbackDeleteCalls = [...ids];
            const result = deleteResult || { ok: true, deletedNodeIds: ["root", "child-1", "child-2"] };
            if (!failDelete) await taskDelete;
            if (result.ok) {
                const all = new Set(result.deletedNodeIds);
                nodes = nodes.filter((node) => !all.has(node.id));
            }
            return result;
        },
        getNode: (nodeId) => nodes.find((node) => node.id === nodeId),
    });
    return { globals, deleteNodes, executeCanvasAgentAction, nodes: () => nodes, resolveDelete: deleteTaskResolve, taskDeleteCalls: () => taskDeleteCalls, callbackDeleteCalls: () => callbackDeleteCalls };
}

async function executeDelete(harness) {
    return harness.executeCanvasAgentAction({ name: "delete_node", arguments: { nodeId: "root" } }, []);
}

test("delete_node waits for real batch deletion and reports every cascaded node", async () => {
    const harness = createHarness();
    let settled = false;
    const action = executeDelete(harness).then((result) => {
        settled = true;
        return result;
    });
    await Promise.resolve();
    assert.equal(settled, false, "delete_node should wait for deleteNodes");
    harness.resolveDelete();
    const result = await action;
    assert.equal(result.ok, true);
    assert.deepEqual(Array.from(result.deletedNodeIds), ["root", "child-1", "child-2"]);
    assert.deepEqual(Array.from(harness.callbackDeleteCalls()), ["root"]);
});

test("actual deleteNodes computes batch cascade and only commits after task deletion succeeds", async () => {
    const harness = createHarness();
    const action = harness.deleteNodes(new Set(["root"]));
    await Promise.resolve();
    assert.deepEqual(harness.nodes().map((node) => node.id), ["root", "child-1", "child-2", "other"]);
    assert.deepEqual(Array.from(harness.taskDeleteCalls()), ["root", "child-1", "child-2"]);
    harness.resolveDelete();
    await action;
    assert.deepEqual(harness.nodes().map((node) => node.id), ["other"]);
});

test("delete_node reports failure and keeps nodes when task deletion fails", async () => {
    const harness = createHarness({ failDelete: true, deleteResult: { ok: false, code: "delete_failed", message: "删除任务记录失败" } });
    const result = await executeDelete(harness);
    assert.equal(result.ok, false);
    assert.equal(result.code, "delete_failed");
    assert.deepEqual(harness.nodes().map((node) => node.id), ["root", "child-1", "child-2", "other"]);
});
