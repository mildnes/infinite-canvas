import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { canvasFixture, project, projectKey, tick } from "./test-utils/canvas-store-fixture.mjs";
import * as hydration from "../app/(user)/canvas/utils/canvas-project-hydration.ts";

const summary = id => ({
    ...project(id), hydrated: false, nodes: [], connections: [], chatSessions: [],
    nodeCount: 2, connectionCount: 0, sessionCount: 1,
});
const full = id => ({ ...project(id), nodes: [project("first").nodes[0], project("second").nodes[0]] });
const header = id => ({ id, title: id, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", nodeCount: 2, connectionCount: 0, sessionCount: 1 });

test("summary boards never reach local persistence after updateProject or flush", async () => {
    const f = canvasFixture(); await tick(); f.clearOperations();
    f.useCanvasStore.setState({ projects: [summary("s")] });
    f.useCanvasStore.getState().updateProject("s", { viewport: { x: 12, y: 5, k: 1 } });
    await f.flushCanvasSaves();
    const persistedSummary = f.writes.some(w => w.key === projectKey("anon", "s") || (w.key.startsWith("infinite-canvas:") && w.value.includes('"id":"s"')));
    assert.equal(persistedSummary, false, "summary must not be serialized into a project or legacy key");
    assert.equal(f.disk.has(projectKey("anon", "s")), false);
});

test("summary boards are excluded from both remote sync and save queues", async () => {
    const f = canvasFixture({ owner: "A", syncEnabled: true }); await tick(); f.clearOperations();
    f.useCanvasStore.setState({ projects: [summary("s")] });
    await f.useCanvasStore.getState().syncWithRemote("A-token", true);
    f.useCanvasStore.getState().updateProject("s", { viewport: { x: 12, y: 5, k: 1 } });
    await f.flushCanvasSaves();
    assert.equal(f.requests.filter(([kind]) => kind === "sync" || kind === "save").length, 0, "summary uploads must be zero");
});

test("detail entry hydrates one summary board by exactly one single-board request", async () => {
    const f = canvasFixture({ owner: "A", remote: [full("s")], syncEnabled: true }); await tick();
    f.useCanvasStore.setState({ projects: [summary("s")] }); f.clearOperations();
    const loaded = await f.useCanvasStore.getState().loadProject?.("s");
    assert.equal(f.requests.filter(([kind]) => kind === "get").length, 1, "detail must call the single-board endpoint once");
    assert.equal(loaded?.nodes.length, 2);
    assert.equal(f.useCanvasStore.getState().projects[0].hydrated, true);
    await f.flushCanvasSaves();
    assert.equal(JSON.parse(f.disk.get(projectKey("A", "s"))).nodes.length, 2);
});

test("detail entry reuses complete local nodes without another single-board request", async () => {
    const f = canvasFixture({ owner: "A", projects: [full("s")] }); await tick(); f.clearOperations();
    const existing = f.useCanvasStore.getState().projects[0];
    const loaded = await f.useCanvasStore.getState().loadProject?.("s");
    assert.equal(loaded, existing, "complete local data must be reused directly");
    assert.equal(f.requests.filter(([kind]) => kind === "get").length, 0);
});

test("23 remote summaries remain visible without persisting any summary boards", async () => {
    const f = canvasFixture({ owner: "A", remote: Array.from({ length: 23 }, (_, i) => header(`p${i}`)), syncEnabled: true });
    await tick(); await f.flushCanvasSaves();
    assert.equal(f.useCanvasStore.getState().projects.length, 23);
    assert.ok(f.useCanvasStore.getState().projects.every(p => p.hydrated === false));
    assert.deepEqual(f.requests.filter(([kind]) => kind === "list").map(([, , mode]) => mode), [true]);
    assert.equal([...f.disk.keys()].filter(key => key.startsWith("canvas_project:")).length, 0);
    const reloaded = canvasFixture({ owner: "A", disk: f.disk, remote: f.useCanvasStore.getState().projects, syncEnabled: true });
    await tick();
    assert.equal(reloaded.useCanvasStore.getState().projects.length, 23);
});

test("summary refresh preserves complete local nodes and does not refetch an unchanged board", async () => {
    const f = canvasFixture({ owner: "A", projects: [full("s")], remote: [header("s")], syncEnabled: true });
    await tick(); await f.flushCanvasSaves();
    const stored = f.useCanvasStore.getState().projects[0];
    assert.equal(stored.nodes.length, 2);
    assert.notEqual(stored.hydrated, false);
    const loaded = await f.useCanvasStore.getState().loadProject("s");
    assert.equal(loaded.nodes.length, 2);
    assert.equal(f.requests.filter(([kind]) => kind === "get").length, 0);
    f.useCanvasStore.setState({ projects: [summary("s")] });
    await f.flushCanvasSaves();
    assert.equal(JSON.parse(f.disk.get(projectKey("A", "s"))).nodes.length, 2, "a summary cannot overwrite or delete a complete disk copy");
});

test("editing a complete board after a summary refresh saves changed counts locally and remotely", async () => {
    const f = canvasFixture({ owner: "A", projects: [full("s")], remote: [header("s")], syncEnabled: true });
    await tick(); await f.flushCanvasSaves();
    const loaded = await f.useCanvasStore.getState().loadProject("s");
    assert.equal(loaded.nodeCount, 2);
    assert.equal(f.requests.filter(([kind]) => kind === "get").length, 0);
    f.clearOperations();
    f.useCanvasStore.getState().updateProject("s", {
        nodes: [...loaded.nodes, project("third").nodes[0]],
        connections: [{ id: "c", source: "first-node", target: "third-node" }],
        chatSessions: [...loaded.chatSessions, { id: "new-chat", messages: [] }],
    });
    await f.flushCanvasSaves();
    const saves = f.requests.filter(([kind]) => kind === "save");
    assert.equal(saves.length, 1, "editing complete data must not be blocked by stale summary counts");
    const stored = JSON.parse(f.disk.get(projectKey("A", "s")));
    assert.equal(stored.nodes.length, 3);
    assert.equal(stored.connections.length, 1);
    assert.equal(stored.chatSessions.length, 2);
    assert.equal(hydration.isCanvasProjectHydrated(stored), true);
    assert.notEqual(stored.remoteUpdatedAt, header("s").updatedAt, "an old summary date must not hide a local edit");
});

test("a new server version or mismatched node count fetches the full board before editing", async () => {
    for (const remote of [{ ...header("s"), updatedAt: "2027-01-01T00:00:00Z" }, { ...header("s"), nodeCount: 3 }]) {
        const f = canvasFixture({ owner: "A", projects: [full("s")], remote: [remote], syncEnabled: true });
        await tick();
        const response = { ...full("s"), updatedAt: remote.updatedAt, nodes: Array.from({ length: remote.nodeCount }, (_, i) => project(`n${i}`).nodes[0]) };
        f.detailGate(Promise.resolve(response));
        const loaded = await f.useCanvasStore.getState().loadProject("s");
        assert.equal(f.requests.filter(([kind]) => kind === "get").length, 1);
        assert.equal(loaded.nodes.length, remote.nodeCount);
        assert.equal(loaded.updatedAt, remote.updatedAt);
    }
});

test("concurrent detail entries fetch only the requested board once and leave others unhydrated", async () => {
    const f = canvasFixture({ owner: "A", remote: [header("s"), header("other")], syncEnabled: true }); await tick();
    let release;
    f.detailGate(new Promise(resolve => { release = resolve; }));
    const first = f.useCanvasStore.getState().loadProject("s");
    const second = f.useCanvasStore.getState().loadProject("s");
    await tick();
    assert.deepEqual(f.requests.filter(([kind]) => kind === "get").map(([, , id]) => id), ["s"]);
    release(full("s"));
    assert.equal(await first, await second);
    await f.flushCanvasSaves();
    assert.equal(f.useCanvasStore.getState().projects.find(p => p.id === "other").hydrated, false);
    assert.equal(f.disk.has(projectKey("A", "other")), false);
});

test("late single-board responses cannot hydrate or persist into a switched account", async () => {
    const f = canvasFixture({ owner: "A", remote: [header("s")], syncEnabled: true }); await tick();
    let release;
    f.detailGate(new Promise(resolve => { release = resolve; }));
    const old = f.useCanvasStore.getState().loadProject("s");
    await tick(); f.switchOwner("B"); await tick();
    f.detailGate(Promise.resolve({ ...full("s"), title: "B full" }));
    await f.useCanvasStore.getState().loadProject("s");
    release({ ...full("s"), title: "A late" });
    assert.equal(await old, null);
    await f.flushCanvasSaves();
    assert.equal(f.useCanvasStore.getState().projects[0].title, "B full");
    assert.equal(JSON.parse(f.disk.get(projectKey("B", "s"))).title, "B full");
});

test("a summary version conflict loads canonical full data and preserves the local conflict draft", async () => {
    const local = { ...full("s"), pendingSave: true, serverUpdatedAt: "2026-01-01T00:00:00Z", title: "my draft" };
    const remote = { ...header("s"), updatedAt: "2027-01-01T00:00:00Z" };
    const f = canvasFixture({ owner: "A", projects: [local], remote: [remote], syncEnabled: true });
    f.detailGate(Promise.resolve({ ...full("s"), updatedAt: remote.updatedAt, title: "canonical" }));
    await tick(); await f.flushCanvasSaves();
    const state = f.useCanvasStore.getState();
    assert.equal(state.projects[0].title, "canonical");
    assert.equal(state.projects[0].nodes.length, 2);
    assert.equal(state.conflictDrafts[0].title, "my draft");
    assert.equal(state.conflictDrafts[0].nodes.length, 2);
    assert.equal(f.requests.filter(([kind]) => kind === "save" || kind === "sync").length, 0);
});

test("a failed detail load leaves the summary intact and can be retried", async () => {
    const f = canvasFixture({ owner: "A", remote: [header("s")], syncEnabled: true }); await tick();
    let reject;
    f.detailGate(new Promise((_, fail) => { reject = fail; }));
    const loading = f.useCanvasStore.getState().loadProject("s");
    reject(new Error("offline"));
    await assert.rejects(loading, /offline/);
    assert.equal(f.useCanvasStore.getState().projects[0].hydrated, false);
    await f.flushCanvasSaves();
    assert.equal(f.disk.has(projectKey("A", "s")), false);
    f.detailGate(Promise.resolve(full("s")));
    const loaded = await f.useCanvasStore.getState().loadProject("s");
    assert.equal(loaded.nodes.length, 2);
    assert.equal(f.requests.filter(([kind]) => kind === "get").length, 2);
});

test("API defaults preserve the complete endpoint; summaries cannot be uploaded at the API boundary", async () => {
    const calls = [], exports = {};
    const request = { apiGet: async (...args) => { calls.push(["get", ...args]); return []; }, apiPost: async (...args) => { calls.push(["post", ...args]); return []; } };
    const modules = {
        "@/app/(user)/canvas/utils/canvas-project-hydration": hydration,
        "@/services/api/request": request,
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ token: "A-token" }) } },
    };
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../services/api/canvas-tasks.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: name => modules[name] || {}, Promise });
    await exports.listCanvasProjects("A-token");
    await exports.listCanvasProjects("A-token", true);
    await exports.getCanvasProject("A-token", "a/b");
    assert.deepEqual(calls.map(([, path]) => path), ["/api/v1/canvas/projects", "/api/v1/canvas/projects?summary=1", "/api/v1/canvas/projects/a%2Fb"]);
    calls.length = 0;
    await assert.rejects(exports.saveCanvasProject("A-token", summary("s")), /不能保存/);
    await exports.syncCanvasProjects("A-token", [summary("s")]);
    assert.equal(calls.length, 0);
    const complete = { ...full("f"), hydrated: true, pendingSave: true, serverUpdatedAt: "version", remoteUpdatedAt: "version", nodeCount: 2 };
    await exports.saveCanvasProject("A-token", complete);
    const data = calls[0][2].data;
    assert.equal(data.nodes.length, 2);
    for (const key of ["hydrated", "pendingSave", "serverUpdatedAt", "remoteUpdatedAt", "nodeCount"]) assert.equal(Object.hasOwn(data, key), false);
});

test("list counts and detail loading are wired to summaries without altering the guest importer", () => {
    const page = readFileSync(new URL("../app/(user)/canvas/[id]/canvas-client-page.tsx", import.meta.url), "utf8");
    const card = readFileSync(new URL("../app/(user)/canvas/components/canvas-project-card.tsx", import.meta.url), "utf8");
    const importer = readFileSync(new URL("../services/storage-migration.ts", import.meta.url), "utf8");
    assert.ok(page.includes("await loadProject(projectId, writerReloadRef.current)"), "detail must await full data before media recovery, forcing a fresh read after writer takeover");
    assert.ok(page.includes("projectLoadError || syncError") && page.includes("<CanvasRefreshShell />"), "detail needs loading and recoverable error states");
    assert.ok(card.includes("project.nodeCount ?? project.nodes.length"), "cards must render summary counts");
    assert.ok(card.includes("await loadProject(project.id)"), "card rename and export must first hydrate");
    assert.ok(importer.includes("listCanvasProjects(token)"), "guest import keeps the existing complete-list endpoint");
});
