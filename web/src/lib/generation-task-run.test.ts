import assert from "node:assert/strict";
import test from "node:test";
import { beginTaskRun, currentTaskRun, taskStopAction, isStoppedTask, acceptsTaskUpdate } from "./generation-task-run";

test("stopping disables action, failed stop is retryable and cancelled regenerates", () => {
 assert.deepEqual(taskStopAction("loading", "stopping"), { label: "停止中", disabled: true });
 assert.deepEqual(taskStopAction("loading", "failed"), { label: "重试停止", disabled: false });
 assert.equal(taskStopAction("cancelled")?.label, "重新生成");
 assert.equal(isStoppedTask("canceled"), true);
});
test("new run aborts old request, fresh id is not reused and late response is rejected", () => {
 const runs = new Map();
 const first = beginTaskRun(runs, "node", "image", "old", "user-1");
 const second = beginTaskRun(runs, "node", "image", "new", "user-1");
 assert.notEqual(first.id, second.id);
 assert.equal(first.controller.signal.aborted, true);
 assert.equal(currentTaskRun(runs, "node", first, "user-1"), false);
 assert.equal(currentTaskRun(runs, "node", second, "user-2"), false);
 assert.equal(currentTaskRun(runs, "node", second, "user-1"), true);
 second.controller.abort();
 assert.equal(currentTaskRun(runs, "node", second, "user-1"), false);
});
test("same account survives JWT rotation because owner id, not token, identifies a run", () => {
 const runs = new Map();
 const run = beginTaskRun(runs, "node", "image", "task", "user-1");
 assert.equal(run.ownerId, "user-1");
 assert.equal("token" in run, false);
 assert.equal(currentTaskRun(runs, "node", run, "user-1"), true);
 assert.equal(currentTaskRun(runs, "node", run, "user-2"), false);
});
test("late processing or completed responses cannot revive cancelled, successful or failed node", () => {
 for (const status of ["cancelled", "success", "error"]) {
  assert.equal(acceptsTaskUpdate(status, "processing"), false);
  assert.equal(acceptsTaskUpdate(status, "completed"), false);
 }
 assert.equal(acceptsTaskUpdate("loading", "cancelled"), true);
 assert.equal(acceptsTaskUpdate("loading", "completed"), true);
});
