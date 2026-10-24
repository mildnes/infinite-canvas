import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const tick = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
const storePath = "../app/(user)/canvas/stores/use-canvas-store.ts";
const key = "infinite-canvas:canvas_store";
const project = () => ({ id: "p", title: "original", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", serverUpdatedAt: "2026-01-01T00:00:00Z", nodes: [], connections: [], chatSessions: [] });

function fixture() {
    const user = require("zustand").create(() => ({ token: "owner-token", user: { id: "owner" }, isReady: true }));
    const timers = new Map(), listeners = new Map(), writes = [], saves = [], deletes = [];
    let time = 0, sequence = 0, failure, saveGate, deleteGate, listGate, sanitized = 0;
    const setTimeout = (fn, delay) => { timers.set(++sequence, { at: time + delay, fn }); return sequence; };
    const clearTimeout = id => timers.delete(id);
    const initial = project();
    const disk = new Map([[key, JSON.stringify({ state: { ownerUserId: "owner", projects: [initial] }, version: 0 })]]);
    const observeDisk = () => {
        const meta = JSON.parse(disk.get("canvas_meta:owner") || "null");
        if (!meta) return;
        writes.push({ state: { ownerUserId: "owner", projects: meta.projectIds.map(id => JSON.parse(disk.get("canvas_project:owner:" + id))), conflictDrafts: meta.conflictDraftIds.map(id => JSON.parse(disk.get("canvas_conflict:owner:" + id))) }, version: meta.version });
    };
    const forage = { getItem: async name => disk.get(name), setItem: async (name, value) => { disk.set(name, value); observeDisk(); }, removeItem: async name => { disk.delete(name); observeDisk(); } };
    const storage = { localForageStorage: { getItem: async name => disk.get(name) || null, setItem: async (name, value) => { disk.set(name, value); writes.push(JSON.parse(value)); }, removeItem: async name => { disk.delete(name); } }, currentStorageOwnerId: () => user.getState().token ? user.getState().user?.id : "anon", waitForStorageOwner: async () => "owner", accountStorageKey: name => name };
    const api = { listCanvasProjects: async () => listGate || [initial], syncCanvasProjects: async (_token, values) => values, saveCanvasProject: async (...args) => { saves.push(args); if (saveGate) await saveGate; if (failure) throw failure; return { ...args[1], updatedAt: "2030-01-01T00:00:00Z" }; }, deleteCanvasProjects: async ids => { deletes.push(ids); if (deleteGate) await deleteGate; if (failure) throw failure; } };
    const modules = { localforage: { default: forage }, zustand: require("zustand"), "zustand/middleware": require("zustand/middleware"), nanoid: { nanoid: () => "new-project" }, "@/lib/localforage-storage": storage, "@/stores/use-user-store": { useUserStore: user }, "@/services/api/canvas-tasks": api, "@/services/api/user-config": { fetchUserConfig: async () => ({ syncCapabilities: { userData: true } }) }, "../utils/canvas-media-persistence": { sanitizeCanvasNodesForPersistence: nodes => { sanitized++; return [...nodes]; }, sanitizeCanvasSessionsForPersistence: sessions => [...sessions] } };
    const exports = {};
    const window = { localStorage: { removeItem: name => disk.delete(name) }, addEventListener: (event, fn) => listeners.set(event, fn), document: { visibilityState: "visible", addEventListener: (event, fn) => listeners.set(event, fn) } };
    const hydrationExports = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../app/(user)/canvas/utils/canvas-project-hydration.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS } }).outputText, { exports: hydrationExports, require: name => modules[name] || {}, Promise, console });
    modules["../utils/canvas-project-hydration"] = hydrationExports;
    const storageExports = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../app/(user)/canvas/stores/canvas-project-storage.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS } }).outputText, { exports: storageExports, require: name => modules[name] || {}, Promise, console, window });
    modules["./canvas-project-storage"] = storageExports;
    const source = process.env.CANVAS_STORE_BASELINE ? execFileSync("git", ["show", process.env.CANVAS_STORE_BASELINE + ":web/src/app/(user)/canvas/stores/use-canvas-store.ts"], { encoding: "utf8" }) : readFileSync(new URL(storePath, import.meta.url), "utf8");
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: name => modules[name] || {}, Promise, console, setTimeout, clearTimeout, window, document: window.document });
    return { ...exports, user, timers, writes, saves, deletes, listeners, fail: error => { failure = error; }, gate: promise => { saveGate = promise; }, listGate: promise => { listGate = promise; }, deletionGate: promise => { deleteGate = promise; }, sanitizations: () => sanitized, advance: async ms => { const until = time + ms; for (;;) { const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; time = due[1].at; timers.delete(due[0]); due[1].fn(); await tick(); } time = until; } };
}

test("pagehide flush persists the last edit and starts remote save inside the debounce window", async () => {
    const f = fixture(); await tick();
    assert.equal(f.useCanvasStore.getState().projects.length, 1, JSON.stringify(f.useCanvasStore.getState()));
    f.useCanvasStore.getState().renameProject("p", "last edit");
    f.listeners.get("pagehide")?.(); await tick();
    assert.equal(f.writes.at(-1)?.state.projects[0].title, "last edit");
    assert.equal(f.saves.at(-1)?.[1].title, "last edit");
});

test("continuous edits have a bounded save delay instead of starving local and remote persistence", async () => {
    const f = fixture(); await tick(); const before = f.writes.length;
    for (let i = 0; i < 25; i++) { f.useCanvasStore.getState().renameProject("p", "edit " + i); await f.advance(100); }
    assert.ok(f.writes.length > before, "continuous changes must persist before the stream finishes");
    assert.ok(f.saves.length > 0, "continuous changes must reach the server");
});

test("unrelated store writes reuse sanitized project references and do not queue another write", async () => {
    const f = fixture(); await tick(); await f.advance(500);
    const before = f.sanitizations();
    f.useCanvasStore.setState({ hydrated: true });
    assert.equal(f.sanitizations(), before);
    assert.equal(f.timers.size, 0);
});

test("canonical server version is adopted and the last known server version is sent as CAS", async () => {
    const f = fixture(); await tick();
    f.useCanvasStore.getState().renameProject("p", "edited"); await f.advance(500);
    assert.equal(f.saves[0]?.[2], "2026-01-01T00:00:00Z");
    assert.equal(f.useCanvasStore.getState().projects[0].updatedAt, "2030-01-01T00:00:00Z");
    assert.equal(f.useCanvasStore.getState().projects[0].serverUpdatedAt, "2030-01-01T00:00:00Z");
});

test("failed save exposes a recoverable error; CAS conflict restores canonical data and keeps the local draft", async () => {
    const f = fixture(); await tick();
    f.fail(Object.assign(new Error("画布已在其他设备更新，请重试"), { status: 409, data: { currentProject: { ...project(), title: "other device", updatedAt: "2027-01-01T00:00:00Z" } } }));
    f.useCanvasStore.getState().renameProject("p", "my draft"); await f.advance(500);
    const state = f.useCanvasStore.getState();
    assert.ok(state.syncError);
    assert.equal(state.projects[0].title, "other device");
    assert.equal(state.conflictDrafts[0].title, "my draft");
    f.fail(undefined); await state.retrySaves();
    assert.equal(f.useCanvasStore.getState().projects[0].title, "my draft");
    assert.equal(f.useCanvasStore.getState().syncError, null);
});

test("deleted remote conflict keeps the local draft without automatic retry", async () => {
    const f = fixture(); await tick();
    f.fail(Object.assign(new Error("画布已删除"), { status: 409, data: { currentProject: null } }));
    f.useCanvasStore.getState().renameProject("p", "local draft"); await f.advance(500);
    const savesBeforeRetry = f.saves.length;
    const state = f.useCanvasStore.getState();
    assert.equal(state.conflictDrafts[0].title, "local draft");
    assert.equal(state.projects[0].pendingSave, false);
    assert.match(state.syncError, /远端画布已删除/);
    await state.retrySaves();
    assert.equal(f.saves.length, savesBeforeRetry);
});

test("project deletion awaits remote success and retains the local project on failure", async () => {
    const f = fixture(); await tick(); let release;
    f.deletionGate(new Promise(resolve => { release = resolve; }));
    const deleting = f.useCanvasStore.getState().deleteProjects(["p"]); await tick();
    assert.equal(f.useCanvasStore.getState().projects.length, 1);
    f.fail(new Error("offline")); release();
    await assert.rejects(deleting, /offline/);
    assert.equal(f.useCanvasStore.getState().projects.length, 1);
    f.fail(undefined); await f.useCanvasStore.getState().deleteProjects(["p"]);
    assert.equal(f.useCanvasStore.getState().projects.length, 0);
});

test("a late save response cannot overwrite newer edits or write into a switched owner", async () => {
    const f = fixture(); await tick(); let release;
    f.gate(new Promise(resolve => { release = resolve; }));
    f.useCanvasStore.getState().renameProject("p", "first"); await f.advance(400);
    f.useCanvasStore.getState().renameProject("p", "newer"); release(); await tick();
    assert.equal(f.useCanvasStore.getState().projects[0].title, "newer");
    assert.equal(f.useCanvasStore.getState().projects[0].serverUpdatedAt, "2030-01-01T00:00:00Z");
});

test("blackhole hydration becomes ready with a recoverable error within 15 seconds and ignores its late result", async () => {
    const f = fixture(); await tick(); let release;
    f.listGate(new Promise(resolve => { release = resolve; }));
    let completed = false;
    const hydrating = f.useCanvasStore.persist.rehydrate().then(() => { completed = true; }); await tick();
    await f.advance(14000);
    assert.equal(completed, true, "blackhole hydration must finish within 15 seconds");
    await hydrating;
    assert.equal(f.useCanvasStore.getState().hydrated, true);
    assert.match(f.useCanvasStore.getState().syncError, /超时/);
    const before = f.writes.length;
    release([{ ...project(), title: "stale response" }]); await tick();
    assert.equal(f.writes.length, before);
    assert.equal(f.useCanvasStore.getState().projects[0].title, "original");
});

test("deleting cancels queued saves so slow deletion cannot recreate the project", async () => {
    const f = fixture(); await tick(); let release;
    f.useCanvasStore.getState().renameProject("p", "pending");
    f.deletionGate(new Promise(resolve => { release = resolve; }));
    const deleting = f.useCanvasStore.getState().deleteProjects(["p"]); await tick();
    await f.advance(2000);
    assert.equal(f.saves.length, 0);
    release(); await deleting;
    assert.equal(f.useCanvasStore.getState().projects.length, 0);
    assert.equal(f.writes.at(-1).state.projects.length, 0);
});

test("account import is idempotent, awaits local persistence and rejects a stale owner", async () => {
    const f = fixture(); await tick();
    const imported = { ...project(), id: "guest", title: "guest project" };
    await f.useCanvasStore.getState().importAccountProjects([imported], "owner", "owner-token");
    assert.ok(f.writes.at(-1).state.projects.some(value => value.id === "guest"));
    await f.useCanvasStore.getState().importAccountProjects([{ ...imported, title: "should not overwrite" }], "owner", "owner-token");
    assert.equal(f.useCanvasStore.getState().projects.find(value => value.id === "guest").title, "guest project");
    await assert.rejects(f.useCanvasStore.getState().importAccountProjects([imported], "wrong", "owner-token"), /账号已切换/);
});
