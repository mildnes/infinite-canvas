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
 const first = beginTaskRun(runs, "node", "image", "old", "token");
 const second = beginTaskRun(runs, "node", "image", "new", "token");
 assert.notEqual(first.id, second.id);
 assert.equal(first.controller.signal.aborted, true);
 assert.equal(currentTaskRun(runs, "node", first, "token"), false);
 assert.equal(currentTaskRun(runs, "node", second, "other-token"), false);
 assert.equal(currentTaskRun(runs, "node", second, "token"), true);
 second.controller.abort();
 assert.equal(currentTaskRun(runs, "node", second, "token"), false);
});
test("late processing or completed responses cannot revive cancelled, successful or failed node", () => {
 for (const status of ["cancelled", "success", "error"]) {
  assert.equal(acceptsTaskUpdate(status, "processing"), false);
  assert.equal(acceptsTaskUpdate(status, "completed"), false);
 }
 assert.equal(acceptsTaskUpdate("loading", "cancelled"), true);
 assert.equal(acceptsTaskUpdate("loading", "completed"), true);
});
