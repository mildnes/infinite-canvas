import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as assetData from "../lib/asset-data.ts";

const require = createRequire(import.meta.url);
const clone = value => JSON.parse(JSON.stringify(value));
const asset = id => ({ id, kind: "image", title: id, coverUrl: "blob:old", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), data: { dataUrl: "blob:old", storageKey: `server:${id}`, width: 10, height: 10, bytes: 10, mimeType: "image/png" } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function server(initial = { assets: [] }) {
    let data = clone(initial), version = 0;
    const posts = [];
    return {
        read: () => clone(data), posts,
        fetchUserAssetData: async () => ({ ...clone(data), revision: String(version) }),
        syncUserAssetData: async (token, next, revision) => {
            posts.push(clone(next));
            if (revision !== String(version)) throw Object.assign(new Error("conflict"), { status: 409 });
            data = clone(next); version++;
            return { ...clone(data), revision: String(version) };
        },
    };
}

function fixture(api = server(), prepare = async value => assetData.normalizeAsset(value)) {
    const user = { token: "owner" }, timers = new Map(), writes = [];
    let persistOptions, sequence = 0, timer = 0, disk;
    const source = readFileSync(new URL("./use-asset-store.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, Date, console, window: { setTimeout: (fn, delay) => { timers.set(++timer, { fn, delay }); return timer; }, clearTimeout: id => timers.delete(id) }, require: name => {
        if (name === "zustand") return require(name);
        if (name === "zustand/middleware") return { persist: (creator, options) => { persistOptions = options; return creator; } };
        if (name === "nanoid") return { nanoid: () => `new-${++sequence}` };
        if (name.endsWith("asset-data")) return assetData;
        if (name.endsWith("asset-storage")) return { prepareAssetForSave: prepare };
        if (name.endsWith("api/user-config")) return api;
        if (name.endsWith("use-user-store")) return { useUserStore: { getState: () => user } };
        if (name.endsWith("localforage-storage")) return { localForageStorage: { getItem: async () => disk, setItem: async (name, value) => { writes.push(JSON.parse(value)); }, removeItem: async () => {} } };
        return {};
    } });
    const store = exports.useAssetStore;
    return { store, user, api, timers, writes, storage: persistOptions.storage, disk: value => { disk = JSON.stringify(value); }, state: () => store.getState(), seed: assets => store.setState({ assets }) };
}

test("hydrate merges unsynced local additions and repairs old URLs; persistence never stores blob references", async () => {
    const f = fixture(server({ assets: [asset("remote")] }));
    f.seed([asset("local")]);
    await f.state().hydrateAccountAssets("owner", true);
    assert.deepEqual(f.state().assets.map(item => item.id).sort(), ["local", "remote"]);
    assert.ok([...f.timers.values()].some(item => item.delay === 600));
    await f.state().syncAccountAssets("owner");
    assert.deepEqual(f.api.read().assets.map(item => item.id).sort(), ["local", "remote"]);
    assert.ok(!JSON.stringify(f.api.read()).includes("blob:"));
    await f.storage.setItem("assets", { state: f.state(), version: 0 });
    assert.ok(!JSON.stringify(f.writes).includes("blob:"));
    f.disk({ state: { assets: [asset("legacy")] }, version: 0 });
    const loaded = await f.storage.getItem("assets");
    assert.equal(loaded.state.assets[0].data.dataUrl, "/api/files/legacy/content");
    assert.deepEqual(loaded.state.tombstones, []);
});

test("two stale tabs read-merge-write concurrently, retry conflicts, then propagate deletion without resurrection", async () => {
    const shared = server(), a = fixture(shared), b = fixture(shared);
    await Promise.all([a.state().hydrateAccountAssets("owner", true), b.state().hydrateAccountAssets("owner", true)]);
    a.seed([asset("a1")]); b.seed([asset("b2")]);
    await Promise.all([a.state().syncAccountAssets("owner"), b.state().syncAccountAssets("owner")]);
    assert.deepEqual(shared.read().assets.map(item => item.id).sort(), ["a1", "b2"]);
    assert.ok(shared.posts.length >= 3, "a real revision conflict must cause retry");
    await a.state().addAsset({ kind: "text", title: "after stale view", coverUrl: "", tags: [], data: { content: "text" } });
    await a.state().syncAccountAssets("owner");
    assert.deepEqual(shared.read().assets.map(item => item.id).sort(), ["a1", "b2", "new-1"]);
    a.state().removeAsset("b2");
    await a.state().syncAccountAssets("owner");
    await b.state().syncAccountAssets("owner");
    assert.ok(!shared.read().assets.some(item => item.id === "b2"));
    assert.ok(!b.state().assets.some(item => item.id === "b2"));
    assert.equal(shared.read().tombstones[0].id, "b2");
});

test("local edits made during an outstanding save are retained and synchronized in a second pass", async () => {
    const shared = server(), gate = deferred(), entered = deferred();
    const api = { ...shared, syncUserAssetData: async (...args) => { if (shared.posts.length === 0) { entered.resolve(); await gate.promise; } return shared.syncUserAssetData(...args); } };
    const f = fixture(api);
    await f.state().hydrateAccountAssets("owner", true);
    f.seed([asset("first")]);
    const pending = f.state().syncAccountAssets("owner");
    await entered.promise;
    await f.state().addAsset({ kind: "text", title: "during upload", coverUrl: "", tags: [], data: { content: "text" } });
    gate.resolve(); await pending;
    assert.deepEqual(shared.read().assets.map(item => item.id).sort(), ["first", "new-1"]);
    assert.equal(shared.posts.length, 2);
});

test("failed sync preserves local data, and late hydrate/save/preparation cannot mutate another account", async () => {
    const shared = server(), gate = deferred();
    const f = fixture({ ...shared, fetchUserAssetData: () => gate.promise });
    const pending = f.state().hydrateAccountAssets("owner", true);
    f.user.token = "other"; f.state().stopAccountAssetSync(); f.seed([asset("other")]);
    gate.resolve({ assets: [asset("late")], revision: "0" }); await pending;
    assert.deepEqual(f.state().assets.map(item => item.id), ["other"]);
    const offline = fixture({ ...shared, syncUserAssetData: async () => { throw new Error("offline"); } });
    await offline.state().hydrateAccountAssets("owner", true); offline.seed([asset("unsynced")]);
    await assert.rejects(offline.state().syncAccountAssets("owner"), /offline/);
    assert.equal(offline.state().assets[0].id, "unsynced");
    const upload = deferred(), g = fixture(shared, () => upload.promise);
    const adding = g.state().addAsset({ kind: "text", title: "old account", coverUrl: "", tags: [], data: { content: "text" } });
    g.user.token = "other"; upload.resolve(asset("old"));
    await assert.rejects(adding, /登录状态已变化/);
    assert.equal(g.state().assets.length, 0);
});
