import assert from "node:assert/strict";
import test from "node:test";
import { canvasFixture, project, projectKey, tick } from "./test-utils/canvas-store-fixture.mjs";

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const value = (projects) => ({ state: { ownerUserId: "anon", projects, conflictDrafts: [] }, version: 0 });
const ids = items => Array.from(items, item => item.id).sort();

test("同步等待列表时的改名和节点编辑保留在内存与磁盘", async () => {
    const a = project("a");
    const f = canvasFixture({ owner: "A", projects: [a], remote: [a], syncEnabled: true });
    await tick();
    const gate = deferred(); f.listGate(gate.promise);
    const sync = f.useCanvasStore.getState().syncWithRemote("A-token", true);
    await tick();
    f.useCanvasStore.getState().renameProject("a", "新标题");
    f.useCanvasStore.getState().updateProject("a", { nodes: [{ id: "edited", content: "新内容", position: { x: 42, y: 73 } }] });
    gate.resolve([a]); await sync; await f.flushCanvasSaves();
    const actual = f.useCanvasStore.getState().projects[0];
    assert.equal(actual.title, "新标题");
    assert.equal(actual.nodes[0].content, "新内容");
    assert.equal(JSON.parse(f.disk.get(projectKey("A", "a"))).title, "新标题");
});

test("同步请求期间新建画板不会消失", async () => {
    const a = project("a");
    const f = canvasFixture({ owner: "A", projects: [a], remote: [a], syncEnabled: true }); await tick();
    const gate = deferred(); f.listGate(gate.promise);
    const sync = f.useCanvasStore.getState().syncWithRemote("A-token", true); await tick();
    const b = f.useCanvasStore.getState().createProject("B");
    gate.resolve([a]); await sync; await f.flushCanvasSaves();
    assert.ok(f.useCanvasStore.getState().projects.some(p => p.id === b));
    assert.ok(f.disk.has(projectKey("A", b)));
});

test("同步请求期间换账号放弃结果且不写旧账号项目", async () => {
    const a = project("a");
    const f = canvasFixture({ owner: "A", projects: [a], remote: [a], syncEnabled: true }); await tick();
    const gate = deferred(); f.listGate(gate.promise);
    const sync = f.useCanvasStore.getState().syncWithRemote("A-token", true); await tick();
    f.listGate(Promise.resolve([]));
    f.switchOwner("B"); await tick(); f.clearOperations();
    gate.resolve([a]); await sync; await tick();
    assert.equal(f.useCanvasStore.getState().ownerUserId, "B");
    assert.ok(!f.useCanvasStore.getState().projects.some(p => p.id === "a"));
    assert.ok(f.writes.every(w => !w.key.includes(":A")));
});

test("远端和请求期间本地都修改时保留最新本机冲突草稿", async () => {
    const a = project("a");
    const remote = { ...a, title: "远端标题", updatedAt: "2027-01-01T00:00:00Z" };
    const f = canvasFixture({ owner: "A", projects: [a], remote: [a], syncEnabled: true }); await tick();
    const gate = deferred(); f.listGate(gate.promise);
    const sync = f.useCanvasStore.getState().syncWithRemote("A-token", true); await tick();
    f.useCanvasStore.getState().renameProject("a", "本机新标题");
    gate.resolve([remote]); await sync; await f.flushCanvasSaves();
    assert.equal(f.useCanvasStore.getState().conflictDrafts.find(p => p.id === "a")?.title, "本机新标题");
    assert.equal(f.useCanvasStore.getState().projects[0].title, "远端标题");
});

test("reconcile 等待补传期间的再次编辑不能被覆盖", async () => {
    const a = project("a");
    const f = canvasFixture({ owner: "A", projects: [a], remote: [a], syncEnabled: true }); await tick();
    f.useCanvasStore.getState().createProject("missing");
    const gate = deferred(); f.syncGate(gate.promise);
    const sync = f.useCanvasStore.getState().syncWithRemote("A-token", true); await tick();
    f.useCanvasStore.getState().renameProject("a", "补传期间的新标题");
    gate.resolve([]); await sync; await f.flushCanvasSaves();
    assert.equal(f.useCanvasStore.getState().projects.find(p => p.id === "a").title, "补传期间的新标题");
});

test("同步列表晚于保存回包时不回滚已经保存的新标题", async () => {
    const a = project("a");
    const f = canvasFixture({ owner: "A", projects: [a], remote: [a], syncEnabled: true }); await tick();
    const gate = deferred(); f.listGate(gate.promise);
    const sync = f.useCanvasStore.getState().syncWithRemote("A-token", true); await tick();
    f.useCanvasStore.getState().renameProject("a", "已保存的新标题");
    await f.flushCanvasSaves();
    assert.equal(f.useCanvasStore.getState().projects[0].pendingSave, false);
    gate.resolve([a]); await sync; await f.flushCanvasSaves();
    assert.equal(f.useCanvasStore.getState().projects[0].title, "已保存的新标题");
});

test("同步等待列表期间删除的画板不会被旧列表加回", async () => {
    const a = project("a");
    const f = canvasFixture({ owner: "A", projects: [a], remote: [a], syncEnabled: true }); await tick();
    const gate = deferred(); f.listGate(gate.promise);
    const sync = f.useCanvasStore.getState().syncWithRemote("A-token", true); await tick();
    await f.useCanvasStore.getState().deleteProjects(["a"]);
    gate.resolve([a]); await sync; await f.flushCanvasSaves();
    assert.deepEqual(ids(f.useCanvasStore.getState().projects), []);
});

test("共享索引保留另一标签新增的画板且都可读取", async () => {
    const f = canvasFixture(); await tick();
    const a = f.createProjectStorage(), b = f.createProjectStorage();
    await a.read("anon", p => p); await b.read("anon", p => p);
    await a.write(value([project("X")]), p => p);
    await b.write(value([project("Y")]), p => p);
    const reloaded = await f.createProjectStorage().read("anon", p => p);
    assert.deepEqual(ids(reloaded.state.projects), ["X", "Y"]);
    assert.ok(reloaded.state.projects.every(p => p.nodes.length === 1));
});

test("删除与陈旧标签新增合并，之后也不复活", async () => {
    const f = canvasFixture(); await tick();
    const a = f.createProjectStorage(), b = f.createProjectStorage();
    await a.write(value([project("X")]), p => p);
    await b.read("anon", p => p);
    await a.write(value([]), p => p);
    await b.write(value([project("X"), project("Y")]), p => p);
    const reloaded = await f.createProjectStorage().read("anon", p => p);
    assert.deepEqual(ids(reloaded.state.projects), ["Y"]);
    await b.write(value([project("X"), project("Y"), project("Z")]), p => p);
    const again = await f.createProjectStorage().read("anon", p => p);
    assert.deepEqual(ids(again.state.projects), ["Y", "Z"]);
    assert.equal(f.disk.has(projectKey("anon", "X")), false);
});

test("旧 format:1 索引仍可读取", async () => {
    const disk = new Map([
        ["canvas_meta:anon", JSON.stringify({ format: 1, ownerUserId: "anon", projectIds: ["X"], conflictDraftIds: [], version: 0 })],
        [projectKey("anon", "X"), JSON.stringify(project("X"))],
    ]);
    const f = canvasFixture({ disk }); await tick();
    assert.deepEqual(ids(f.useCanvasStore.getState().projects), ["X"]);
});

test("没有 Web Locks 的同时写索引仍可恢复两张画板", async () => {
    const f = canvasFixture(); await tick();
    const a = f.createProjectStorage(), b = f.createProjectStorage();
    await a.read("anon", p => p); await b.read("anon", p => p);
    const gate = deferred();
    let arrived = 0;
    f.setWriteGate(async key => {
        if (key === "canvas_meta:anon" && ++arrived === 1) await gate.promise;
    });
    const first = a.write(value([project("X")]), p => p);
    await tick();
    await b.write(value([project("Y")]), p => p);
    gate.resolve(); await first;
    assert.deepEqual(JSON.parse(f.disk.get("canvas_meta:anon")).projectIds, ["X"], "force the stale index to finish last");
    f.setWriteGate(undefined);
    const reloaded = await f.createProjectStorage().read("anon", p => p);
    assert.deepEqual(ids(reloaded.state.projects), ["X", "Y"]);
});

test("索引被陈旧标签覆盖也不能抹掉独立删除记录", async () => {
    const f = canvasFixture(); await tick();
    const a = f.createProjectStorage();
    await a.write(value([project("X")]), p => p);
    const staleMeta = f.disk.get("canvas_meta:anon");
    await a.write(value([]), p => p);
    // A late tab may publish its old index and even an old board payload.
    f.disk.set("canvas_meta:anon", staleMeta);
    f.disk.set(projectKey("anon", "X"), JSON.stringify(project("X")));
    const reloaded = await f.createProjectStorage().read("anon", p => p);
    assert.deepEqual(ids(reloaded.state.projects), []);
});

test("共享索引合并不读取其他账号的画板与墓碑", async () => {
    const f = canvasFixture(); await tick();
    f.disk.set(projectKey("B", "foreign"), JSON.stringify(project("foreign")));
    f.disk.set("canvas_deleted:B:X", JSON.stringify({ id: "X" }));
    f.clearOperations();
    const a = f.createProjectStorage();
    await a.write(value([project("X")]), p => p);
    const reloaded = await f.createProjectStorage().read("anon", p => p);
    assert.deepEqual(ids(reloaded.state.projects), ["X"]);
    assert.ok(f.reads.every(key => !key.includes(":B")));
    assert.ok(f.writes.every(item => !item.key.includes(":B")));
});

test("Web Locks 将同账号共享索引的并发读改写串行化", async () => {
    let queue = Promise.resolve(), active = 0, maxActive = 0;
    const names = [];
    const locks = { request(name, callback) {
        names.push(name);
        const request = queue.then(async () => {
            maxActive = Math.max(maxActive, ++active);
            try { return await callback(); } finally { active--; }
        });
        queue = request.catch(() => {});
        return request;
    } };
    const f = canvasFixture({ locks }); await tick();
    const a = f.createProjectStorage(), b = f.createProjectStorage();
    await a.read("anon", p => p); await b.read("anon", p => p);
    await Promise.all([a.write(value([project("X")]), p => p), b.write(value([project("Y")]), p => p)]);
    assert.equal(maxActive, 1);
    assert.ok(names.every(name => name === "canvas_meta:anon"));
    assert.deepEqual(JSON.parse(f.disk.get("canvas_meta:anon")).projectIds, ["X", "Y"]);
});
