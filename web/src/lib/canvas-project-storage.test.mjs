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
