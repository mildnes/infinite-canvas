import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import * as assetData from "./asset-data.ts";

const require = createRequire(import.meta.url);
const tick = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
const canvasKey = "infinite-canvas:canvas_store";
const assetKey = "infinite-canvas:asset_store";
const project = id => ({ id, title: id, createdAt: "2026-01-01", updatedAt: "2026-01-01", nodes: [], connections: [], chatSessions: [] });
const asset = id => ({ id, kind: "text", title: id, tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { content: id } });

function fixture() {
    const user = require("zustand").create(() => ({ token: "A-token", user: { id: "A" }, isReady: true }));
    user.persist = { hasHydrated: () => true };
    const disk = new Map(), operations = [], posts = [], saves = [], timers = new Map();
    const remote = { A: [], B: [] };
    let sequence = 0, nextRead, listGate, listOwner;
    const forage = { config: () => {}, getItem: async key => { operations.push(["get", key]); if (nextRead) { const gate = nextRead; nextRead = null; return gate; } return disk.get(key); }, setItem: async (key, value) => { operations.push(["set", key]); disk.set(key, value); }, removeItem: async key => { operations.push(["remove", key]); disk.delete(key); } };
    const owner = token => token.split("-")[0];
    const modules = {
        "localforage": { default: forage }, "zustand": require("zustand"), "zustand/middleware": require("zustand/middleware"),
        "nanoid": { nanoid: () => "new-" + ++sequence },
        "@/stores/use-user-store": { useUserStore: user }, "@/lib/asset-data": assetData,
        "@/services/asset-storage": { prepareAssetForSave: async value => assetData.normalizeAsset(value) },
        "@/services/api/user-config": { fetchUserConfig: async () => ({ syncCapabilities: { userData: true } }), fetchUserAssetData: async () => ({ assets: [], tombstones: [], revision: "0" }), syncUserAssetData: async (token, payload) => { posts.push({ token, payload }); return payload; } },
        "@/services/api/canvas-tasks": { listCanvasProjects: async token => listGate && owner(token) === listOwner ? listGate : remote[owner(token)] || [], syncCanvasProjects: async (token, projects) => { posts.push({ token, projects }); return projects; }, saveCanvasProject: async (token, data) => { saves.push({ token, data }); } },
        "../utils/canvas-media-persistence": { sanitizeCanvasNodesForPersistence: nodes => nodes, sanitizeCanvasSessionsForPersistence: sessions => sessions },
    };
    const context = { Promise, console: { ...console, warn: (...args) => operations.push(["warn", ...args]) }, window: { localStorage: { getItem: key => disk.get(key), setItem: (key, value) => disk.set(key, value), removeItem: key => disk.delete(key) }, setTimeout: fn => { timers.set(++sequence, fn); return sequence; }, clearTimeout: id => timers.delete(id) }, setTimeout: fn => { timers.set(++sequence, fn); return sequence; }, clearTimeout: id => timers.delete(id), require: name => modules[name] || {} };
    const load = path => { const exports = {}; const source = process.env.STORAGE_OWNER_BASELINE && path === "./localforage-storage.ts" ? execFileSync("git", ["show", process.env.STORAGE_OWNER_BASELINE + ":web/src/lib/localforage-storage.ts"], { encoding: "utf8" }) : readFileSync(new URL(path, import.meta.url), "utf8"); vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS } }).outputText, { ...context, exports }); return exports; };
    const storage = load("./localforage-storage.ts");
    modules["@/lib/localforage-storage"] = storage;
    modules["../utils/canvas-project-hydration"] = load("../app/(user)/canvas/utils/canvas-project-hydration.ts");
    modules["./canvas-project-storage"] = load("../app/(user)/canvas/stores/canvas-project-storage.ts");
    return { user, disk, operations, posts, saves, timers, remote, storage, load, delayedRead: promise => { nextRead = promise; }, delayedList: promise => { listGate = promise; listOwner = user.getState().user?.id; }, switchOwner: id => user.setState({ token: id === "anon" ? "" : id + "-token", user: id === "anon" ? null : { id }, isReady: true }), seed: (key, id, records) => disk.set(key + ":" + id, JSON.stringify({ state: { ownerUserId: id, ...(key === canvasKey ? { projects: records } : { assets: records, tombstones: [] }) }, version: 0 })) };
}

test("account adapter isolates keys, ignores legacy keys and rejects stale writes before accessing B", async () => {
    const f = fixture();
    f.disk.set(canvasKey, "legacy");
    assert.equal(await f.storage.localForageStorage.getItem(canvasKey), null);
    assert.equal(f.disk.get(canvasKey), "legacy");
    const payload = JSON.stringify({ state: { ownerUserId: "A", projects: [project("A")] } });
    await f.storage.localForageStorage.setItem(canvasKey, payload);
    f.switchOwner("B");
    await f.storage.localForageStorage.setItem(canvasKey, payload);
    assert.equal(f.disk.has(canvasKey + ":B"), false);
    assert.ok(f.operations.some(row => row[0] === "warn"));
    f.user.setState({ token: "unresolved", user: null });
    const before = f.operations.length;
    assert.equal(await f.storage.localForageStorage.getItem(assetKey), null);
    await f.storage.localForageStorage.setItem(assetKey, payload);
    assert.equal(f.operations.length, before);
    f.switchOwner("anon");
    assert.equal(f.storage.accountStorageKey(canvasKey), canvasKey + ":anon");
    assert.equal(f.storage.accountStorageKey("other-store"), "other-store");
});

test("real canvas store switches A / anon / B / A without cross-account upload or losing local copies", async () => {
    const f = fixture();
    f.seed(canvasKey, "A", [project("A-local")]);
    f.seed(canvasKey, "B", [project("B-local")]);
    f.seed(canvasKey, "anon", [project("anon-local")]);
    f.disk.set(canvasKey, "legacy-untouched");
    const store = f.load("../app/(user)/canvas/stores/use-canvas-store.ts").useCanvasStore;
    await tick();
    assert.deepEqual(Array.from(store.getState().projects, p => p.id), ["A-local"], JSON.stringify({ operations: f.operations, state: store.getState(), disk: [...f.disk] }));
    store.getState().renameProject("A-local", "A changed");
    f.switchOwner("anon");
    assert.equal(store.getState().projects.length, 0);
    await tick();
    assert.equal(store.getState().projects[0].id, "anon-local");
    f.switchOwner("B");
    await tick();
    await store.getState().syncWithRemote("B-token", true);
    assert.equal(store.getState().projects[0].id, "B-local");
    for (const fn of [...f.timers.values()]) fn();
    await tick();
    assert.ok(f.posts.filter(p => p.token === "B-token").every(p => p.projects.every(p => p.id === "B-local")));
    assert.ok(!f.saves.some(p => p.token === "B-token" && p.data.id === "A-local"));
    assert.equal(JSON.parse(f.disk.get("canvas_project:B:B-local")).id, "B-local");
    assert.equal(f.disk.has(canvasKey + ":B"), false, "the migrated account key is replaced by isolated board keys");
    f.switchOwner("A"); await tick();
    assert.equal(store.getState().projects[0].id, "A-local");
    assert.equal(f.disk.get(canvasKey), "legacy-untouched");
    assert.ok(!f.operations.some(([action, key]) => action === "get" && key === canvasKey));
});

test("same-account user refresh keeps canvas owner stable without clearing or rehydrating", async () => {
    const f = fixture();
    f.seed(canvasKey, "A", [project("A-local")]);
    const store = f.load("../app/(user)/canvas/stores/use-canvas-store.ts").useCanvasStore;
    await tick();
    const before = f.operations.filter(([action, key]) => action === "get" && key === canvasKey + ":A").length;
    const projects = store.getState().projects;

    f.user.setState({ isReady: false });
    await tick();
    f.user.setState({ isReady: true });
    await tick();

    assert.equal(store.getState().ownerUserId, "A");
    assert.equal(store.getState().projects[0]?.id, "A-local");
    assert.equal(store.getState().projects, projects, "same-account refresh must not replace canvas state");
    assert.equal(
        f.operations.filter(([action, key]) => action === "get" && key === canvasKey + ":A").length,
        before,
        "same-account refresh must not rehydrate the canvas store",
    );
});

test("real account switch still resets and rehydrates exactly one new owner", async () => {
    const f = fixture();
    f.seed(canvasKey, "A", [project("A-local")]);
    f.seed(canvasKey, "B", [project("B-local")]);
    const store = f.load("../app/(user)/canvas/stores/use-canvas-store.ts").useCanvasStore;
    await tick();
    const before = f.operations.filter(([action, key]) => action === "get" && key === canvasKey + ":B").length;

    f.switchOwner("B");
    await tick();

    assert.equal(store.getState().ownerUserId, "B");
    assert.equal(store.getState().projects[0]?.id, "B-local");
    assert.equal(
        f.operations.filter(([action, key]) => action === "get" && key === canvasKey + ":B").length,
        before + 1,
        "a real owner change must trigger one rehydrate for the new account",
    );
});

test("real asset store switches owners without merging A assets or tombstones into B", async () => {
    const f = fixture();
    f.seed(assetKey, "A", [asset("A-local")]); f.seed(assetKey, "B", [asset("B-local")]);
    const store = f.load("../stores/use-asset-store.ts").useAssetStore;
    await tick();
    assert.equal(store.getState().assets[0].id, "A-local");
    f.switchOwner("B"); await tick();
    await store.getState().hydrateAccountAssets("B-token", true);
    await store.getState().syncAccountAssets("B-token");
    assert.equal(store.getState().assets[0].id, "B-local");
    assert.ok(f.posts.every(p => p.payload.assets.every(a => a.id === "B-local")));
    f.switchOwner("A"); await tick();
    assert.equal(store.getState().assets[0].id, "A-local");
});

test("adapter discards delayed reads and canvas remote responses from the previous owner", async () => {
    const f = fixture(); let finish;
    f.delayedRead(new Promise(resolve => { finish = resolve; }));
    const reading = f.storage.localForageStorage.getItem(canvasKey);
    await tick(); f.switchOwner("B"); finish("old-A");
    assert.equal(await reading, null);
    f.seed(canvasKey, "B", [project("B-local")]);
    const store = f.load("../app/(user)/canvas/stores/use-canvas-store.ts").useCanvasStore;
    await tick();
    f.delayedList(new Promise(resolve => { finish = resolve; }));
    const syncing = store.getState().syncWithRemote("B-token", true);
    await tick(); f.switchOwner("A"); finish([project("late-B")]);
    await syncing; await tick();
    assert.ok(!store.getState().projects.some(p => p.id === "late-B"));
    assert.ok(!f.posts.some(p => p.token === "A-token" && p.projects?.some(p => p.id === "B-local")));
});

test("waiting for an unresolved owner has a deadline and releases subscriptions", async () => {
    const f = fixture();
    f.user.setState({ isReady: false });
    const waiting = f.storage.waitForStorageOwner();
    await tick();
    assert.ok(f.timers.size > 0, "owner hydration must have a timeout");
    for (const fn of [...f.timers.values()]) fn();
    await assert.rejects(waiting, /超时/);
    f.user.setState({ isReady: true });
    assert.equal(await f.storage.waitForStorageOwner(), "A");
});
