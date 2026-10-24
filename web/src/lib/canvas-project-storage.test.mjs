import assert from "node:assert/strict";
import test from "node:test";
import { canvasFixture, legacyKey, metaKey, projectKey, project, tick } from "./test-utils/canvas-store-fixture.mjs";

test("only the edited board is written, below 400,000 characters", async () => {
    const f = canvasFixture({ projects: ["a", "b", "c"].map(id => project(id, 200_000)) });
    await tick(); await f.flushCanvasSaves(); f.clearOperations();
    f.useCanvasStore.getState().updateProject("b", { viewport: { x: 20, y: 30, k: 1 } });
    await f.flushCanvasSaves();
    assert.deepEqual(f.writes.map(w => w.key), [projectKey("anon", "b")]);
    const chars = f.writes.reduce((sum, w) => sum + w.chars, 0);
    assert.ok(chars < 400_000, `single-board write must be <400000 characters, actual=${chars}`);
    console.log(`single-board write: ${chars} characters`);
});

test("single-board write volume is independent of 3 versus 20 boards", async () => {
    const volumes = [];
    for (const count of [3, 20]) {
        const f = canvasFixture({ projects: Array.from({ length: count }, (_, i) => project(`p${i}`, 200_000)) });
        await tick(); await f.flushCanvasSaves(); f.clearOperations();
        f.useCanvasStore.getState().updateProject("p0", { viewport: { x: 1, y: 1, k: 1 } });
        await f.flushCanvasSaves();
        volumes.push(f.writes.reduce((sum, w) => sum + w.chars, 0));
    }
    assert.equal(volumes[1], volumes[0], `3 boards=${volumes[0]}, 20 boards=${volumes[1]}`);
    assert.ok(volumes[1] < 400_000);
    console.log(`write volume 3/20 boards: ${volumes.join("/")}`);
});

test("legacy migration restores five boards, sessions and drafts before removing the old key", async () => {
    const projects = Array.from({ length: 5 }, (_, i) => project(`p${i}`));
    const f = canvasFixture({ projects, drafts: [project("draft")] });
    await tick();
    assert.equal(f.useCanvasStore.getState().projects.length, 5);
    assert.equal(f.useCanvasStore.getState().conflictDrafts[0].id, "draft");
    assert.equal(f.disk.has(`${legacyKey}:anon`), false, "legacy key is removed only after the split migration completes");
    for (const p of projects) assert.ok(f.disk.has(projectKey("anon", p.id)));
    assert.ok(f.disk.has(metaKey("anon")));
    const refreshed = canvasFixture({ disk: f.disk }); await tick();
    assert.equal(refreshed.useCanvasStore.getState().projects.length, 5);
    assert.equal(refreshed.useCanvasStore.getState().projects[3].activeChatId, "p3-chat");
    assert.equal(refreshed.useCanvasStore.getState().conflictDrafts[0].id, "draft");
});

test("failed partial migration retains readable legacy data and succeeds on retry", async () => {
    const f = canvasFixture({ projects: ["a", "b", "c"].map(id => project(id)) });
    let failures = 0;
    f.setFailure(key => key === projectKey("anon", "b") && ++failures > 0);
    await tick();
    assert.equal(f.useCanvasStore.getState().projects.length, 3);
    assert.ok(f.disk.has(`${legacyKey}:anon`));
    assert.ok(failures > 0, "migration must attempt the split write and exercise the injected failure");
    assert.equal(f.disk.has(metaKey("anon")), false, "partial migration must not publish its completion marker");
    f.setFailure(undefined);
    await f.useCanvasStore.persist.rehydrate(); await tick();
    assert.equal(f.disk.has(`${legacyKey}:anon`), false);
    assert.equal(f.useCanvasStore.getState().projects.length, 3);
});

test("deleteProjects removes the board key and its index entry", async () => {
    const f = canvasFixture({ projects: [project("a"), project("b")] });
    await tick();
    await f.useCanvasStore.getState().deleteProjects(["a"]);
    assert.ok(f.removes.includes(projectKey("anon", "a")), "deleted board must be removed from IndexedDB");
    assert.equal(f.disk.has(projectKey("anon", "a")), false);
    const refreshed = canvasFixture({ disk: f.disk }); await tick();
    assert.deepEqual(Array.from(refreshed.useCanvasStore.getState().projects, p => p.id), ["b"]);
});

test("project keys are isolated across A, anon and B owners", async () => {
    const disk = new Map();
    for (const owner of ["A", "anon", "B"]) disk.set(`${legacyKey}:${owner}`, JSON.stringify({ state: { ownerUserId: owner, projects: [project(`${owner}-board`)] }, version: 0 }));
    const f = canvasFixture({ owner: "A", disk }); await tick();
    assert.ok(f.disk.has(projectKey("A", "A-board")), "A must have an owner-scoped project key");
    f.switchOwner("anon"); await tick();
    assert.equal(f.useCanvasStore.getState().projects[0].id, "anon-board");
    f.switchOwner("B"); await tick();
    assert.equal(f.useCanvasStore.getState().projects[0].id, "B-board");
    f.clearOperations();
    f.useCanvasStore.getState().updateProject("B-board", { viewport: { x: 2, y: 2, k: 1 } });
    await f.flushCanvasSaves();
    assert.ok(f.writes.every(w => w.key.startsWith("canvas_project:B:") || w.key === metaKey("B")));
    f.switchOwner("A"); await tick();
    assert.equal(f.useCanvasStore.getState().projects[0].id, "A-board");
});

test("23 boards and conflict drafts survive a complete store reload", async () => {
    const f = canvasFixture({ projects: Array.from({ length: 23 }, (_, i) => project(`p${i}`, 1000)), drafts: [project("conflict", 200_000)] });
    await tick(); await f.flushCanvasSaves();
    assert.ok(f.disk.get(metaKey("anon")).length < 1000, "conflict bodies must not bloat the metadata key");
    const reloaded = canvasFixture({ disk: f.disk }); await tick();
    assert.equal(reloaded.useCanvasStore.getState().projects.length, 23);
    assert.equal(reloaded.useCanvasStore.getState().projects[22].chatSessions[0].id, "p22-chat");
    assert.equal(reloaded.useCanvasStore.getState().conflictDrafts[0].nodes[0].content.length, 200_000);
});

test("a failed board save is retried without losing the last edit", async () => {
    const f = canvasFixture({ projects: [project("a"), project("b")] });
    await tick(); f.clearOperations();
    f.setFailure(key => key === projectKey("anon", "a"));
    f.useCanvasStore.getState().updateProject("a", { viewport: { x: 42, y: 0, k: 1 } });
    await assert.rejects(f.flushCanvasSaves(), /disk failure/);
    assert.equal(JSON.parse(f.disk.get(projectKey("anon", "a"))).viewport, undefined);
    f.setFailure(undefined); await f.flushCanvasSaves();
    assert.equal(JSON.parse(f.disk.get(projectKey("anon", "a"))).viewport.x, 42);
    assert.ok(f.writes.every(w => w.key === projectKey("anon", "a")));
});

test("changed references or changed updatedAt are both persisted, once per flush", async () => {
    const f = canvasFixture({ projects: [project("a")] });
    await tick(); f.clearOperations();
    const p = f.useCanvasStore.getState().projects[0];
    p.updatedAt = "2027-01-01T00:00:00Z";
    f.useCanvasStore.setState({ projects: [p] });
    await f.flushCanvasSaves();
    assert.equal(f.writes.length, 1);
    assert.equal(JSON.parse(f.writes[0].value).updatedAt, p.updatedAt);
    f.clearOperations();
    f.useCanvasStore.setState({ projects: [{ ...p, title: "same timestamp, new ref" }] });
    await f.flushCanvasSaves();
    assert.equal(f.writes.length, 1);
    assert.equal(JSON.parse(f.writes[0].value).title, "same timestamp, new ref");
});

test("queued writes to the same board remain serial and retain the latest edit", async () => {
    const f = canvasFixture({ projects: [project("a")] });
    await tick(); f.clearOperations();
    let release;
    f.setWriteGate(() => new Promise(resolve => { release = resolve; }));
    f.useCanvasStore.getState().updateProject("a", { viewport: { x: 1, y: 0, k: 1 } });
    const first = f.flushCanvasSaves(); await tick();
    f.useCanvasStore.getState().updateProject("a", { viewport: { x: 2, y: 0, k: 1 } });
    const second = f.flushCanvasSaves(); await tick();
    assert.equal(f.writes.length, 1, "a queued flush cannot write the same key concurrently");
    f.setWriteGate(undefined); release();
    await Promise.all([first, second]);
    assert.equal(JSON.parse(f.disk.get(projectKey("anon", "a"))).viewport.x, 2);
    assert.equal(f.writes.length, 2);
});

test("a board ID is written at most once per flush", async () => {
    const f = canvasFixture({ projects: [project("a")] });
    await tick(); f.clearOperations();
    const p = f.useCanvasStore.getState().projects[0];
    f.useCanvasStore.setState({ projects: [{ ...p, title: "first" }, { ...p, title: "latest" }] });
    await f.flushCanvasSaves();
    assert.equal(f.writes.filter(w => w.key === projectKey("anon", "a")).length, 1);
    assert.equal(JSON.parse(f.disk.get(projectKey("anon", "a"))).title, "latest");
});

test("a legacy package is merged into the existing split index instead of being dropped", async () => {
    const disk = new Map();
    const first = canvasFixture({ projects: [project("a")], disk });
    await tick(); await first.flushCanvasSaves();
    assert.ok(disk.has(metaKey("anon")), "first load must have written the split index");
    // A rollback to a pre-split build rewrites the whole package, adding a board the index never saw.
    disk.set(`${legacyKey}:anon`, JSON.stringify({ state: { ownerUserId: "anon", projects: [project("a"), project("b")], conflictDrafts: [] }, version: 0 }));
    const second = canvasFixture({ disk });
    await tick();
    const ids = Array.from(second.useCanvasStore.getState().projects, item => item.id).sort();
    assert.deepEqual(ids, ["a", "b"], "both the indexed and the legacy board must survive");
    assert.ok(disk.has(projectKey("anon", "b")), "the legacy-only board must be written to its own key");
    assert.equal(disk.has(`${legacyKey}:anon`), false, "the legacy package is removed only after the merge is persisted");
});

test("a newer legacy copy wins over the stale split copy", async () => {
    const disk = new Map();
    const first = canvasFixture({ projects: [project("a")], disk });
    await tick(); await first.flushCanvasSaves();
    const newer = { ...project("a"), title: "rollback-edit", updatedAt: "2026-06-01T00:00:00Z" };
    disk.set(`${legacyKey}:anon`, JSON.stringify({ state: { ownerUserId: "anon", projects: [newer], conflictDrafts: [] }, version: 0 }));
    const second = canvasFixture({ disk });
    await tick();
    const loaded = second.useCanvasStore.getState().projects.find(item => item.id === "a");
    assert.equal(loaded.title, "rollback-edit", "edits made during rollback must not be reverted");
    assert.equal(JSON.parse(disk.get(projectKey("anon", "a"))).title, "rollback-edit");
});

test("a failed merge retains the legacy package and succeeds on retry", async () => {
    const disk = new Map();
    const first = canvasFixture({ projects: [project("a")], disk });
    await tick(); await first.flushCanvasSaves();
    disk.set(`${legacyKey}:anon`, JSON.stringify({ state: { ownerUserId: "anon", projects: [project("a"), project("b")], conflictDrafts: [] }, version: 0 }));
    const second = canvasFixture({ disk });
    second.setFailure(key => key === projectKey("anon", "b"));
    await tick();
    assert.equal(disk.has(`${legacyKey}:anon`), true, "a failed merge must keep the legacy package");
    assert.ok(disk.has(projectKey("anon", "a")), "already indexed boards stay readable");
    second.setFailure(undefined);
    const third = canvasFixture({ disk });
    await tick();
    assert.ok(third.disk.has(projectKey("anon", "b")), "the retry must complete the merge");
    assert.equal(third.disk.has(`${legacyKey}:anon`), false);
});

test("another account's legacy package is neither merged nor deleted", async () => {
    const disk = new Map();
    const first = canvasFixture({ projects: [project("a")], disk });
    await tick(); await first.flushCanvasSaves();
    disk.set(`${legacyKey}:anon`, JSON.stringify({ state: { ownerUserId: "someone-else", projects: [project("z")], conflictDrafts: [] }, version: 0 }));
    const second = canvasFixture({ disk });
    await tick();
    const ids = Array.from(second.useCanvasStore.getState().projects, item => item.id);
    assert.deepEqual(ids, ["a"], "a foreign package must never be read into this account");
    assert.equal(disk.has(projectKey("anon", "z")), false);
    assert.equal(disk.has(`${legacyKey}:anon`), true, "a foreign package must be left untouched");
});

test("incomplete legacy entries are not promoted but complete ones are merged", async () => {
    const disk = new Map();
    const first = canvasFixture({ projects: [project("a")], disk });
    await tick(); await first.flushCanvasSaves();
    const summaryLike = { ...project("s"), hydrated: false, nodes: [], nodeCount: 3 };
    disk.set(`${legacyKey}:anon`, JSON.stringify({ state: { ownerUserId: "anon", projects: [project("v"), summaryLike], conflictDrafts: [] }, version: 0 }));
    const second = canvasFixture({ disk });
    await tick();
    assert.ok(disk.has(projectKey("anon", "v")), "a complete legacy board must be merged");
    assert.equal(disk.has(projectKey("anon", "s")), false, "an incomplete legacy entry must never be written");
});

test("a stale summary nodeCount must not block edits to a complete board", async () => {
    const f = canvasFixture({ projects: [project("a")], syncEnabled: true });
    await tick(); f.clearOperations();
    const loaded = f.useCanvasStore.getState().projects[0];
    // What syncWithRemote does: the summary counters land on an already-complete local board.
    f.useCanvasStore.setState({ projects: [{ ...loaded, nodeCount: 99, connectionCount: 42, sessionCount: 7 }] });
    f.useCanvasStore.getState().updateProject("a", { viewport: { x: 5, y: 6, k: 1 } });
    await tick(); await f.flushCanvasSaves();
    const edited = f.useCanvasStore.getState().projects.find(item => item.id === "a");
    assert.equal(edited.viewport.x, 5, "a complete board must stay editable even when the summary counter is stale");
    assert.equal(JSON.parse(f.disk.get(projectKey("anon", "a"))).viewport.x, 5, "the edit must be persisted locally");
});

test("a summary-only board is still not editable", async () => {
    const f = canvasFixture({ projects: [project("a")] });
    await tick(); f.clearOperations();
    f.useCanvasStore.setState({ projects: [{ id: "a", title: "a", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", hydrated: false, nodes: [], connections: [], chatSessions: [], nodeCount: 3, connectionCount: 0, sessionCount: 0 }] });
    f.useCanvasStore.getState().updateProject("a", { viewport: { x: 9, y: 9, k: 1 } });
    await tick(); await f.flushCanvasSaves();
    assert.equal(f.requests.length, 0, "a summary must never be edited or saved");
});
