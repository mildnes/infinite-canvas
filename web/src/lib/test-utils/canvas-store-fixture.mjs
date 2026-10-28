import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
export const tick = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
export const legacyKey = "infinite-canvas:canvas_store";
export const projectKey = (owner, id) => `canvas_project:${owner}:${id}`;
export const metaKey = owner => `canvas_meta:${owner}`;
export const project = (id, size = 0) => ({
    id, title: id, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    nodes: [{ id: `${id}-node`, type: "text", content: "x".repeat(size) }], connections: [],
    chatSessions: [{ id: `${id}-chat`, messages: [] }], activeChatId: `${id}-chat`,
});

export function canvasFixture({ owner = "anon", projects = [], drafts = [], disk = new Map(), idbDisk = disk, localDisk = disk, remote = [], syncEnabled = false, locks, baseline = process.env.CANVAS_STORE_BASELINE } = {}) {
    const user = require("zustand").create(() => ({ token: owner === "anon" ? "" : `${owner}-token`, user: owner === "anon" ? null : { id: owner }, isReady: true }));
    user.persist = { hasHydrated: () => true };
    const writes = [], removes = [], reads = [], requests = [], errors = [], timers = new Map(), modules = {};
    let failure, removeFailure, time = 0, sequence = 0, detailGate, listGate, syncGate, readGate, writeGate, localFailure, localRemoveFailure;
    if (projects.length || drafts.length) idbDisk.set(`${legacyKey}:${owner}`, JSON.stringify({ state: { ownerUserId: owner, projects, conflictDrafts: drafts }, version: 0 }));
    const forage = {
        config() {},
        async keys() { return [...idbDisk.keys()]; },
        async getItem(key) { reads.push(key); if (readGate) await readGate(key); return idbDisk.get(key) ?? null; },
        async setItem(key, value) {
            writes.push({ key, value, chars: typeof value === "string" ? value.length : JSON.stringify(value).length });
            if (failure?.(key, value)) throw new Error("injected disk failure");
            if (writeGate) await writeGate(key, value);
            idbDisk.set(key, value);
            return value;
        },
        async removeItem(key) {
            removes.push(key);
            if (removeFailure?.(key)) throw new Error("injected disk failure");
            idbDisk.delete(key);
        },
    };
    const setTimeout = (fn, delay = 0) => { timers.set(++sequence, { at: time + delay, fn }); return sequence; };
    const clearTimeout = id => timers.delete(id);
    const context = {
        Promise, crypto: globalThis.crypto, navigator: { locks }, console: { ...console, error() {}, warn() {} }, setTimeout, clearTimeout,
        window: { addEventListener() {}, localStorage: {
            get length() { return localDisk.size; },
            key: index => [...localDisk.keys()][index] ?? null,
            getItem: key => localDisk.get(key) ?? null,
            setItem: (key, value) => { if (localFailure?.(key)) throw new Error("injected disk failure"); localDisk.set(key, value); },
            removeItem: key => { if (localRemoveFailure?.(key)) throw new Error("injected disk failure"); localDisk.delete(key); },
        } },
    };
    const api = {
        async listCanvasProjects(token, summary) { requests.push(["list", token, summary]); return listGate ? await listGate : remote; },
        async getCanvasProject(token, id) { requests.push(["get", token, id]); return detailGate ? await detailGate : remote.find(p => p.id === id); },
        async syncCanvasProjects(token, values) { requests.push(["sync", token, values]); return syncGate ? await syncGate : values; },
        async saveCanvasProject(token, value) { requests.push(["save", token, value]); return value; },
        async deleteCanvasProjects(ids) { requests.push(["delete", ids]); },
    };
    Object.assign(modules, {
        localforage: { default: forage }, zustand: require("zustand"), "zustand/middleware": {
            ...require("zustand/middleware"),
            persist: (config, options) => require("zustand/middleware").persist(config, {
                ...options,
                onRehydrateStorage: (...args) => {
                    const complete = options.onRehydrateStorage?.(...args);
                    return (state, error) => { if (error) errors.push(error); complete?.(state, error); };
                },
            }),
        },
        nanoid: { nanoid: () => `new-${++sequence}` }, "@/stores/use-user-store": { useUserStore: user },
        "@/services/api/user-config": { fetchUserConfig: async () => ({ syncCapabilities: { userData: syncEnabled } }) },
        "@/services/api/canvas-tasks": api,
        "../utils/canvas-media-persistence": { sanitizeCanvasNodesForPersistence: nodes => nodes, sanitizeCanvasSessionsForPersistence: sessions => sessions },
    });
    function load(relative) {
        const path = new URL(relative, import.meta.url);
        const exports = {};
        const sourceRevision = /use-canvas-store\.ts$/.test(relative) ? baseline
            : /canvas-project-storage\.ts$/.test(relative) ? process.env.CANVAS_STORAGE_BASELINE : null;
        const source = sourceRevision
            ? execFileSync("git", ["show", `${sourceRevision}:web/src/app/(user)/canvas/stores/${path.pathname.split("/").pop()}`], { encoding: "utf8" })
            : readFileSync(path, "utf8");
        vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS } }).outputText, { ...context, exports, require: name => {
            if (modules[name]) return modules[name];
            throw new Error(`Missing fixture dependency ${name}`);
        } });
        return exports;
    }
    modules["@/lib/localforage-storage"] = load("../localforage-storage.ts");
    const hydration = "../../app/(user)/canvas/utils/canvas-project-hydration.ts";
    if (existsSync(new URL(hydration, import.meta.url))) modules["../utils/canvas-project-hydration"] = load(hydration);
    modules["../utils/canvas-writer-lock"] = load("../../app/(user)/canvas/utils/canvas-writer-lock.ts");
    const helper = "../../app/(user)/canvas/stores/canvas-project-storage.ts";
    if (existsSync(new URL(helper, import.meta.url))) modules["./canvas-project-storage"] = load(helper);
    const exported = load("../../app/(user)/canvas/stores/use-canvas-store.ts");
    return {
        ...exported, user, disk, idbDisk, localDisk, writes, removes, reads, requests, errors, storage: modules["@/lib/localforage-storage"],
        createProjectStorage: modules["./canvas-project-storage"].createCanvasProjectStorage,
        setFailure: fn => { failure = fn; },
        setRemoveFailure: fn => { removeFailure = fn; },
        setLocalStorageFailure: fn => { localFailure = fn; },
        setLocalStorageRemoveFailure: fn => { localRemoveFailure = fn; },
        setReadGate: fn => { readGate = fn; },
        setWriteGate: fn => { writeGate = fn; },
        detailGate: promise => { detailGate = promise; },
        listGate: promise => { listGate = promise; },
        syncGate: promise => { syncGate = promise; },
        switchOwner: id => user.setState({ token: id === "anon" ? "" : `${id}-token`, user: id === "anon" ? null : { id }, isReady: true }),
        clearOperations() { writes.length = removes.length = reads.length = requests.length = 0; },
        async advance(ms) {
            const until = time + ms;
            for (;;) {
                const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                time = due[1].at; timers.delete(due[0]); due[1].fn(); await tick();
            }
            time = until;
        },
    };
}
