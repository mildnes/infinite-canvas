import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const page = readFileSync(new URL("../app/(user)/canvas/[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const dialog = process.env.CANVAS_STORE_BASELINE
    ? execFileSync("git", ["show", `${process.env.CANVAS_STORE_BASELINE}:web/src/app/(user)/canvas/components/canvas-delete-projects-dialog.tsx`], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8" })
    : readFileSync(new URL("../app/(user)/canvas/components/canvas-delete-projects-dialog.tsx", import.meta.url), "utf8");
function callback(source, name, context) {
    const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expression;
    const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer; ts.forEachChild(node, visit); };
    visit(ast);
    const exports = {};
    vm.runInNewContext(ts.transpileModule("exports.run = " + expression.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, { exports, ...context });
    return exports.run;
}

test("pointerup persists the final pointer coordinates even before React commits setNodes", () => {
    let nodes = [{ id: "n", type: "image", position: { x: 10, y: 20 } }];
    const writes = [];
    const ref = { current: nodes };
    const finish = callback(page, "finishNodeDrag", { rafRef: { current: null }, dragRef: { current: { isDraggingNode: true, hasMoved: true, startX: 0, startY: 0, initialSelectedNodes: [{ id: "n", x: 10, y: 20 }], clickedGroupId: null } }, historyPausedRef: { current: true }, nodeDraggingRef: { current: true }, viewportRef: { current: { k: 2 } }, nodesRef: ref, persistCurrentCanvasRef: { current: next => writes.push(next) }, setNodes: updater => { /* React has not committed this queued update yet. */ }, setIsNodeDragging() {}, setDropTargetGroupId() {}, findGroupDropTarget: () => null, findContainingGroupId: () => undefined, CanvasNodeType: { Group: "group" }, setDialogNodeId() {} });
    finish(100, 60);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0].position.x, 60);
    assert.equal(writes[0][0].position.y, 50);
});

test("delete dialog waits for remote deletion and keeps selection and local data after failure", async () => {
    const calls = []; let resolveTasks; let resolveProject;
    const confirm = callback(dialog, "confirm", { ids: ["p"], deleting: false, setDeleting: state => calls.push(["busy", state]), deleteProjects: () => new Promise(done => { calls.push(["project"]); resolveProject = done; }), deleteCanvasProjects: () => { throw new Error("fire-and-forget must not be used"); }, deleteCanvasTasks: () => new Promise(done => { calls.push(["tasks"]); resolveTasks = done; }), cleanupImages: () => calls.push(["cleanup"]), removeSelectedIds: () => calls.push(["selection"]), setDeleteIds: () => calls.push(["close"]), message: { error: text => calls.push(["error", text]) } });
    const pending = confirm();
    assert.ok(!calls.some(([name]) => name === "cleanup" || name === "close"));
    await new Promise(setImmediate);
    assert.ok(calls.some(([name]) => name === "tasks"));
    assert.ok(!calls.some(([name]) => name === "project"));
    resolveTasks(); await new Promise(setImmediate);
    assert.ok(typeof resolveProject === "function");
    resolveProject(); await pending;
    assert.ok(calls.some(([name]) => name === "close"));
});
