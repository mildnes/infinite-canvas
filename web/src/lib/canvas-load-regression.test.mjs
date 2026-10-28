import assert from "node:assert/strict";
import test from "node:test";
import { canvasFixture, metaKey, project, projectKey, tick } from "./test-utils/canvas-store-fixture.mjs";

const makeLocks = () => {
    const pending = new Map();
    return {
        request(name, callback) {
            const next = (pending.get(name) || Promise.resolve()).then(callback);
            pending.set(name, next.catch(() => {}));
            return next;
        },
    };
};
const header = id => ({
    id, title: id, ...Object.fromEntries(["createdAt", "updatedAt"].map(key => [key, project(id)[key]])),
    nodeCount: 1, connectionCount: 0, sessionCount: 1,
});

for (const owner of ["anon", "account"]) {
    for (const withLocks of [false, true]) {
        test(`接管只读取目标，不把另一窗口新增画板变成删除项 (${owner}, locks=${withLocks})`, async () => {
            const disk = new Map(), locks = withLocks ? makeLocks() : undefined;
            const a = canvasFixture({ owner, projects: [project("X")], disk, locks });
            await tick(); await a.flushCanvasSaves();
            const b = canvasFixture({ owner, disk, locks });
            await tick();
            const y = b.useCanvasStore.getState().importProject({ ...project("Y"), title: "B 的新画板" });
            await b.flushCanvasSaves();
            assert.deepEqual(Array.from(a.useCanvasStore.getState().projects, item => item.id), ["X"]);

            const loaded = await a.useCanvasStore.getState().loadProject("X", true);
            assert.equal(loaded.id, "X");
            a.useCanvasStore.getState().updateProject("X", { viewport: { x: 23, y: 45, k: 1 } });
            await a.flushCanvasSaves();
            assert.equal(disk.has(projectKey(owner, y)), true, "接管后保存不得删除 B 新增画板正文");
            assert.equal(disk.has(`canvas_deleted:${owner}:${y}`), false, "不得为未加载的 Y 写删除墓碑");
            const meta = JSON.parse(disk.get(metaKey(owner)));
            assert.ok(meta.projectIds.includes(y), "共享索引必须保留 Y");
            assert.ok(!meta.deletedProjectIds?.includes(y));
            const reloaded = canvasFixture({ owner, disk, locks });
            await tick();
            assert.deepEqual(new Set(Array.from(reloaded.useCanvasStore.getState().projects, item => item.id)), new Set(["X", y]));
            assert.equal(reloaded.useCanvasStore.getState().projects.find(item => item.id === y).title, "B 的新画板");
        });
    }
}

test("真实 HTTP 404 回退本地完整副本，保留版本且不自动上报", async () => {
    const local = { ...project("X"), title: "本地完整版本", serverUpdatedAt: project("X").updatedAt };
    const f = canvasFixture({ owner: "A", projects: [local], remote: [header("X")], syncEnabled: true });
    await tick(); await f.flushCanvasSaves(); f.clearOperations();
    f.idbDisk.set(projectKey("A", "X"), JSON.stringify(local));
    const error = Object.assign(new Error("画板不存在"), { status: 404 });
    f.detailGate(Promise.reject(error));
    const loaded = await f.useCanvasStore.getState().loadProject("X", true);
    assert.equal(loaded.title, local.title);
    assert.equal(loaded.nodes.length, 1);
    assert.equal(loaded.serverUpdatedAt, local.serverUpdatedAt);
    await f.flushCanvasSaves();
    assert.equal(f.requests.filter(([kind]) => ["save", "sync"].includes(kind)).length, 0);
    assert.equal(JSON.parse(f.disk.get(projectKey("A", "X"))).title, local.title);
});

test("404 没有完整本地副本时明确失败，不把摘要当成画板", async () => {
    const f = canvasFixture({ owner: "A", remote: [header("X")], syncEnabled: true });
    await tick();
    const error = Object.assign(new Error("画板不存在"), { status: 404 });
    f.detailGate(Promise.reject(error));
    await assert.rejects(f.useCanvasStore.getState().loadProject("X", true), value => value === error);
    assert.equal(f.useCanvasStore.getState().projects[0].hydrated, false);
    assert.equal(f.disk.has(projectKey("A", "X")), false);
});

test("401、403、500 和网络错误不伪装成云端缺失", async () => {
    for (const status of [401, 403, 500, undefined]) {
        const f = canvasFixture({ owner: "A", projects: [project("X")], remote: [header("X")], syncEnabled: true });
        await tick(); await f.flushCanvasSaves(); f.clearOperations();
        const error = Object.assign(new Error(`failure ${status}`), { status });
        f.detailGate(Promise.reject(error));
        await assert.rejects(f.useCanvasStore.getState().loadProject("X", true), value => value === error);
        assert.equal(f.reads.filter(key => key === projectKey("A", "X")).length, 0, "明确错误不能触发本地回退读取");
    }
});

for (const outcome of ["edit", "new-request", "switch-owner"]) {
    test(`本地接管读取等待期间的 ${outcome} 不被迟到磁盘快照覆盖`, async () => {
        const f = canvasFixture({ projects: [project("X")] });
        await tick(); await f.flushCanvasSaves();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        f.setReadGate(key => key === projectKey("anon", "X") ? gate : undefined);
        const old = f.useCanvasStore.getState().loadProject("X", true);
        await tick();
        f.setReadGate(undefined);
        if (outcome === "edit") {
            f.useCanvasStore.getState().renameProject("X", "读取期间的新标题");
        } else if (outcome === "new-request") {
            f.disk.set(projectKey("anon", "X"), JSON.stringify({ ...project("X"), title: "后发请求读取的新版本" }));
            await f.useCanvasStore.getState().loadProject("X", true);
            // The older read now returns stale bytes despite completing last.
            f.disk.set(projectKey("anon", "X"), JSON.stringify(project("X")));
        } else {
            f.switchOwner("B"); await tick();
        }
        release();
        const result = await old;
        if (outcome === "edit") {
            assert.equal(result.title, "读取期间的新标题");
            assert.equal(f.useCanvasStore.getState().projects[0].title, "读取期间的新标题");
        } else if (outcome === "new-request") {
            assert.equal(result, null, "被新加载替代的本地读取必须放弃");
            assert.equal(f.useCanvasStore.getState().projects[0].title, "后发请求读取的新版本");
        } else {
            assert.equal(result, null);
            assert.equal(f.useCanvasStore.getState().ownerUserId, "B");
            assert.equal(f.useCanvasStore.getState().projects.length, 0);
        }
    });
}

test("404 回退等待期间的新编辑优先，且旧请求不能发布本地副本", async () => {
    const f = canvasFixture({ owner: "A", projects: [project("X")], remote: [header("X")], syncEnabled: true });
    await tick(); await f.flushCanvasSaves();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    f.setReadGate(key => key === projectKey("A", "X") ? gate : undefined);
    f.detailGate(Promise.reject(Object.assign(new Error("not found"), { status: 404 })));
    // Attach a rejection handler before yielding; old code rejects before reading disk.
    const loading = f.useCanvasStore.getState().loadProject("X", true);
    void loading.catch(() => {});
    await tick();
    f.useCanvasStore.getState().renameProject("X", "404 等待期间的编辑");
    f.setReadGate(undefined); release();
    assert.equal((await loading).title, "404 等待期间的编辑");
    assert.equal(f.useCanvasStore.getState().projects[0].title, "404 等待期间的编辑");
});
