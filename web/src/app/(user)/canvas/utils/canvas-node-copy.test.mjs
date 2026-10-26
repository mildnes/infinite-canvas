import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = process.env.CANVAS_COPY_BASELINE
    ? execFileSync("git", ["show", `${process.env.CANVAS_COPY_BASELINE}:web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`], { encoding: "utf8" })
    : readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("canvas.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function walk(node) {
    if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), node);
    ts.forEachChild(node, walk);
}
walk(ast);
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const root = () => ({ id: "root", title: "root", type: "image", width: 100, height: 100, position: { x: 0, y: 0 },
    metadata: { isBatchRoot: true, batchChildIds: ["c1", "c2"], primaryImageId: "c1", status: "loading",
        imageTaskId: "task", imageTaskResultId: "result", content: "/api/files/original/content", storageKey: "server:original" } });
const batch = () => [root(), ...["c1", "c2"].map(id => ({ ...root(), id, metadata: { batchRootId: "root", imageTaskId: "task", imageTaskResultId: id } }))];

function harness(items) {
    const scope = {
        nodesRef: { current: items }, connectionsRef: { current: [] }, selectedNodeIdsRef: { current: new Set() }, clipboardRef: { current: null },
        requireCanvasWriter: () => true, CanvasNodeType: { Group: "group" }, getCanvasCenter: () => ({ x: 500, y: 500 }),
        setNodes: next => { scope.nodesRef.current = typeof next === "function" ? next(scope.nodesRef.current) : next; },
        setConnections: next => { scope.connectionsRef.current = typeof next === "function" ? next(scope.connectionsRef.current) : next; },
        setSelectedNodeIds: ids => { scope.selectedNodeIdsRef.current = ids; },
        deleteCanvasTaskRecords: async () => {}, collectImageStorageKeys: () => new Set(), useAssetStore: { getState: () => ({ assets: [] }) },
        historyRef: {}, lastHistoryRef: {}, projectId: "project", chatSessions: [], cleanupCanvasFiles() {}, message: { error() {} },
    };
    for (const name of ["setSelectedConnectionId", "setDialogNodeId", "setContextMenu", "setChatSessions", "setHoveredNodeId", "setToolbarNodeId", "setInfoNodeId", "setCropNodeId", "setMaskEditNodeId", "setAngleNodeId", "setPreviewNodeId", "setRunningNodeId", "setReferencePickerNodeId"]) scope[name] = () => {};
    const helper = new URL("./canvas-node-copy.ts", import.meta.url);
    if (existsSync(helper)) {
        const exports = {};
        vm.runInNewContext(compile(readFileSync(helper, "utf8")), { exports });
        Object.assign(scope, exports);
    }
    for (const name of ["duplicateNode", "copySelectedNodes", "pasteCopiedNodes", "deleteNodes"]) {
        const fn = declarations.get(name).initializer.arguments[0].getText(ast);
        scope[name] = vm.runInNewContext(compile(`(${fn})`), scope);
    }
    return scope;
}

test("单选复制批次根清除批次与任务归属但保留媒体", () => {
    const h = harness(batch()); h.duplicateNode("root");
    const copied = h.nodesRef.current.at(-1);
    for (const key of ["isBatchRoot", "batchChildIds", "batchRootId", "imageTaskId", "imageTaskResultId"]) {
        assert.equal(copied.metadata[key], undefined, key);
    }
    assert.equal(copied.metadata.storageKey, "server:original");
    assert.equal(copied.metadata.status, "success");
});

test("删除单节点副本不级联原批次，删原根仍级联", async () => {
    const h = harness(batch()); h.duplicateNode("root");
    await h.deleteNodes(new Set([h.nodesRef.current.at(-1).id]));
    assert.deepEqual(Array.from(h.nodesRef.current, p => p.id), ["root", "c1", "c2"]);
    await h.deleteNodes(new Set(["root"]));
    assert.equal(h.nodesRef.current.length, 0);
});

test("完整批次粘贴重映射根子图与连线，删除不碰原批次", async () => {
    const h = harness(batch());
    h.connectionsRef.current = [{ id: "edge", fromNodeId: "root", toNodeId: "c1" }];
    h.selectedNodeIdsRef.current = new Set(["root", "c1", "c2"]);
    h.copySelectedNodes(); h.pasteCopiedNodes();
    const copied = h.nodesRef.current.slice(3), newRoot = copied[0];
    assert.deepEqual(Array.from(newRoot.metadata.batchChildIds), Array.from(copied.slice(1), p => p.id));
    assert.equal(newRoot.metadata.primaryImageId, copied[1].id);
    for (const child of copied.slice(1)) assert.equal(child.metadata.batchRootId, newRoot.id);
    for (const node of copied) assert.equal(node.metadata.imageTaskId, undefined);
    assert.equal(h.connectionsRef.current[1].fromNodeId, newRoot.id);
    await h.deleteNodes(new Set([newRoot.id]));
    assert.deepEqual(Array.from(h.nodesRef.current, p => p.id), ["root", "c1", "c2"]);
});

test("重复复制和不完整批次粘贴都是独立副本", async () => {
    const h = harness(batch()); h.duplicateNode("root"); h.duplicateNode("root");
    const [first, second] = h.nodesRef.current.slice(3);
    await h.deleteNodes(new Set([first.id]));
    assert.ok(h.nodesRef.current.some(p => p.id === second.id));
    assert.ok(h.nodesRef.current.some(p => p.id === "root"));
    h.selectedNodeIdsRef.current = new Set(["root", "c1"]);
    h.copySelectedNodes(); h.pasteCopiedNodes();
    for (const node of h.nodesRef.current.slice(-2)) {
        assert.equal(node.metadata.batchRootId, undefined);
        assert.equal(node.metadata.isBatchRoot, undefined);
    }
});
