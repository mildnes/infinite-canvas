import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const storePath = "../stores/use-canvas-store.ts";
const project = (title = "original") => ({
    id: "p",
    title,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    serverUpdatedAt: "2026-01-01T00:00:00Z",
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    agentConfig: null,
    autoTitlePending: false,
    backgroundMode: "lines",
    showImageInfo: false,
    showConnections: true,
    snapToGrid: false,
    viewport: { x: 0, y: 0, k: 1 },
    sidePanel: { open: true, width: 280 },
    agentPanel: { open: false, width: 390 },
});
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture() {
    const user = require("zustand").create(() => ({ token: "A-token", user: { id: "A" }, isReady: true }));
    user.persist = { hasHydrated: () => true };
    const timers = new Map();
    const timerStacks = new Map();
    const saves = [];
    const pendingSaves = new Map();
    let time = 0;
    let sequence = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let failure;
    const initial = project();
    const disk = new Map();
    const storage = {
        localForageStorage: {
            getItem: async () => JSON.stringify({ state: { ownerUserId: "A", projects: [initial] }, version: 0 }),
            setItem: async () => {},
            removeItem: async () => {},
        },
        currentStorageOwnerId: () => user.getState().token ? user.getState().user?.id : "anon",
        waitForStorageOwner: async () => user.getState().user?.id || "anon",
        accountStorageKey: name => name,
    };
    const api = {
        listCanvasProjects: async () => [initial],
        syncCanvasProjects: async (_token, values) => values,
        saveCanvasProject: async (token, value, baseUpdatedAt) => {
            saves.push({ token, value, baseUpdatedAt, at: time });
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                await new Promise(resolve => pendingSaves.set(saves.length, resolve));
                if (failure) throw failure;
                return { ...value, updatedAt: `2030-01-01T00:00:0${saves.length}Z` };
            } finally {
                inFlight--;
            }
        },
        deleteCanvasProjects: async () => {},
    };
    const modules = {
        localforage: { default: { getItem: async key => disk.get(key), setItem: async (key, value) => disk.set(key, value), removeItem: async key => disk.delete(key) } },
        zustand: require("zustand"),
        "zustand/middleware": require("zustand/middleware"),
        nanoid: { nanoid: () => "new-project" },
        "@/lib/localforage-storage": storage,
        "@/stores/use-user-store": { useUserStore: user },
        "@/services/api/canvas-tasks": api,
        "@/services/api/user-config": { fetchUserConfig: async () => ({ syncCapabilities: { userData: true } }) },
        "../utils/canvas-media-persistence": {
            sanitizeCanvasNodesForPersistence: nodes => nodes,
            sanitizeCanvasSessionsForPersistence: sessions => sessions,
        },
    };
    const exports = {};
    const window = {
        localStorage: { removeItem: () => {} },
        addEventListener: () => {},
        document: { visibilityState: "visible", addEventListener: () => {} },
    };
    const setTimeout = (fn, delay) => {
        const id = ++sequence;
        timers.set(id, { at: time + delay, fn });
        timerStacks.set(id, new Error().stack);
        return id;
    };
    const clearTimeout = id => { timers.delete(id); timerStacks.delete(id); };
    const source = process.env.CANVAS_STORE_BASELINE
        ? execFileSync("git", ["show", `${process.env.CANVAS_STORE_BASELINE}:web/src/app/(user)/canvas/stores/use-canvas-store.ts`], { cwd: new URL("../../../../..", import.meta.url), encoding: "utf8" })
        : readFileSync(new URL(storePath, import.meta.url), "utf8");
    const hydrationExports = {};
    vm.runInNewContext(
        ts.transpileModule(readFileSync(new URL("./canvas-project-hydration.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS } }).outputText,
        { exports: hydrationExports, require: name => modules[name] || {}, Promise, console },
    );
    modules["../utils/canvas-project-hydration"] = hydrationExports;
    const storageExports = {};
    vm.runInNewContext(
        ts.transpileModule(readFileSync(new URL("../stores/canvas-project-storage.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS } }).outputText,
        { exports: storageExports, require: name => modules[name] || {}, Promise, console, window },
    );
    modules["./canvas-project-storage"] = storageExports;
    vm.runInNewContext(
        ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS } }).outputText,
        { exports, require: name => modules[name] || {}, Promise, console, setTimeout, clearTimeout, window, document: window.document },
    );
    return {
        ...exports,
        user,
        timers,
        timerStacks,
        saves,
        pendingSaves,
        get maxInFlight() { return maxInFlight; },
        release: (id = 1) => { const resolve = pendingSaves.get(id); pendingSaves.delete(id); resolve?.(); },
        fail: error => { failure = error; },
        advance: async ms => {
            const until = time + ms;
            for (;;) {
                const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                time = due[1].at;
                timers.delete(due[0]);
                timerStacks.delete(due[0]);
                due[1].fn();
                await tick();
            }
            time = until;
            await tick();
        },
    };
}

test("3 次分别到期的保存尝试最多 1 个在途，并在完成后串行刷出合并后的最后一次更新", async () => {
    const f = fixture();
    await tick();
    const store = f.useCanvasStore.getState();
    store.renameProject("p", "first");
    await f.advance(400);
    assert.equal(f.saves.length, 1, `expected one initial save, actual ${f.saves.length}`);
    store.renameProject("p", "second");
    await f.advance(400);
    store.renameProject("p", "third");
    await f.advance(400);
    assert.equal(f.saves.length, 1, `expected overlapping attempts to wait, actual ${f.saves.length}`);
    assert.equal(f.maxInFlight, 1, `expected max in-flight 1, actual ${f.maxInFlight}`);
    f.release(1);
    await tick();
    assert.equal(f.saves.length, 2, `expected one merged follow-up save, actual ${f.saves.length}`);
    assert.equal(f.saves[1].value.title, "third");
    assert.equal(f.maxInFlight, 1, `expected max in-flight 1, actual ${f.maxInFlight}`);
    f.release(2);
    await tick();
    assert.equal(f.saves.length, 2, `expected no duplicate save, actual ${f.saves.length}`);
});

test("保存期间的更新在完成后必须再发一次，不丢最后一次更新", async () => {
    const f = fixture();
    await tick();
    f.useCanvasStore.getState().renameProject("p", "first");
    await f.advance(400);
    assert.equal(f.saves.length, 1);
    f.useCanvasStore.getState().renameProject("p", "last");
    f.release(1);
    await tick();
    assert.equal(f.saves.length, 2, `expected a follow-up save, actual ${f.saves.length}`);
    assert.equal(f.saves[1].value.title, "last");
    assert.equal(f.maxInFlight, 1, `expected max in-flight 1, actual ${f.maxInFlight}`);
    f.release(2);
    await tick();
    assert.equal(f.saves.length, 2, `expected no extra save, actual ${f.saves.length}`);
});

test("切号会清掉旧账号 pending，旧内容不会以新账号 token 发出", async () => {
    const f = fixture();
    await tick();
    f.useCanvasStore.getState().renameProject("p", "old-account-draft");
    f.user.setState({ token: "B-token", user: { id: "B" }, isReady: true });
    await tick();
    const oldSaveTimers = [...f.timerStacks.values()].filter(stack => /queueProjectSave/.test(stack || ""));
    assert.equal(oldSaveTimers.length, 0, `expected old owner project timers to be cleared, actual ${oldSaveTimers.length}\n${oldSaveTimers.join("\n")}`);
    await f.advance(2500);
    assert.deepEqual(f.saves.filter(save => save.token === "B-token"), []);
    assert.ok(f.saves.every(save => save.token === "A-token"));
});

test("400ms 去抖仍生效，连续更新不会立即发请求", async () => {
    const f = fixture();
    await tick();
    f.useCanvasStore.getState().renameProject("p", "one");
    await f.advance(399);
    assert.equal(f.saves.length, 0, `expected no save before 400ms, actual ${f.saves.length}`);
    f.useCanvasStore.getState().renameProject("p", "two");
    await f.advance(399);
    assert.equal(f.saves.length, 0, `expected no save after debounce reset, actual ${f.saves.length}`);
    await f.advance(1);
    assert.equal(f.saves.length, 1, `expected one save after quiet 400ms, actual ${f.saves.length}`);
    assert.equal(f.saves[0].value.title, "two");
    f.release(1);
    await tick();
});

test("保存失败时保留在途期间的最后内容，并可经 retrySaves 重新发送", async () => {
    const f = fixture();
    await tick();
    f.useCanvasStore.getState().renameProject("p", "first");
    await f.advance(400);
    f.useCanvasStore.getState().renameProject("p", "last");
    f.fail(new Error("offline"));
    f.release(1);
    await tick();
    assert.equal(f.useCanvasStore.getState().projects[0].title, "last");
    assert.equal(f.useCanvasStore.getState().projects[0].pendingSave, true);
    f.fail(undefined);
    const retry = f.useCanvasStore.getState().retrySaves();
    await tick();
    assert.equal(f.saves.at(-1).value.title, "last");
    f.release(2);
    await retry;
    await tick();
    assert.equal(f.useCanvasStore.getState().projects[0].pendingSave, false);
});

test("持续编辑超过 2 秒仍会在 max timer 到期后落地，后续 burst 会重新 arm", async () => {
    const f = fixture();
    await tick();
    for (let i = 0; i < 25; i++) {
        f.useCanvasStore.getState().renameProject("p", `burst-${i}`);
        await f.advance(100);
    }
    assert.ok(f.saves.length >= 1, `expected a save before continuous edits end, actual ${f.saves.length}`);
    assert.equal(f.saves[0].value.title, "burst-19");
    f.release();
    await tick();
    await f.advance(2500);
    assert.ok(f.saves.some(save => save.value.title === "burst-24"), "last burst update must eventually save");
    for (const id of [...f.pendingSaves.keys()]) f.release(id);
    await tick();
});

const conflict = () => Object.assign(new Error("conflict"), {
    status: 409,
    data: { currentProject: { ...project("remote"), updatedAt: "2029-01-01T00:00:00Z" } },
});

async function conflictDuringSave(f) {
    await tick();
    f.useCanvasStore.getState().renameProject("p", "first");
    await f.advance(400);
    f.useCanvasStore.getState().renameProject("p", "last");
    f.fail(conflict());
    f.release(1);
    await tick();
    f.fail(undefined);
}

test("409 停止自动续刷 canonical remote，最后编辑保留为冲突草稿", async () => {
    const f = fixture();
    await conflictDuringSave(f);
    await f.advance(2500);
    assert.deepEqual(f.saves.map(save => save.value.title), ["first"]);
    assert.equal(f.useCanvasStore.getState().projects[0].title, "remote");
    assert.equal(f.useCanvasStore.getState().conflictDrafts[0]?.title, "last");
    assert.ok(f.useCanvasStore.getState().syncError);
});

test("409 后的新编辑保持本地且不自动发送，显式重试恢复草稿并使用 canonical CAS", async () => {
    const f = fixture();
    await conflictDuringSave(f);
    f.useCanvasStore.getState().renameProject("p", "after-conflict");
    await f.advance(2500);
    assert.deepEqual(f.saves.map(save => save.value.title), ["first"]);
    assert.equal(f.useCanvasStore.getState().projects[0].title, "after-conflict");
    assert.equal(f.useCanvasStore.getState().conflictDrafts[0]?.title, "last");
    const retry = f.useCanvasStore.getState().retrySaves();
    await tick();
    assert.equal(f.saves.at(-1).value.title, "last");
    assert.equal(f.saves.at(-1).baseUpdatedAt, "2029-01-01T00:00:00Z");
    assert.equal(f.useCanvasStore.getState().conflictDrafts[0]?.title, "last");
    f.release(2);
    await retry;
    assert.equal(f.useCanvasStore.getState().projects[0].title, "last");
    assert.equal(f.useCanvasStore.getState().conflictDrafts.length, 0);
    assert.equal(f.useCanvasStore.getState().syncError, null);
});

test("成功响应保留保存开始后出现的未解决草稿，显式重试失败仍保留草稿", async () => {
    const f = fixture();
    await tick();
    f.useCanvasStore.getState().renameProject("p", "first");
    await f.advance(400);
    f.useCanvasStore.setState({ conflictDrafts: [project("unresolved")] });
    f.release(1);
    await tick();
    assert.equal(f.useCanvasStore.getState().conflictDrafts[0]?.title, "unresolved");
    const retry = f.useCanvasStore.getState().retrySaves();
    await tick();
    f.fail(new Error("offline"));
    f.release(2);
    await retry;
    assert.equal(f.useCanvasStore.getState().conflictDrafts[0]?.title, "unresolved");
    assert.equal(f.useCanvasStore.getState().projects[0].pendingSave, true);
});

test("显式重试期间的新编辑在草稿保存成功后串行发送，并沿用新 CAS", async () => {
    const f = fixture();
    await conflictDuringSave(f);
    const retry = f.useCanvasStore.getState().retrySaves();
    await tick();
    f.useCanvasStore.getState().renameProject("p", "during-retry");
    f.release(2);
    await retry;
    await tick();
    assert.deepEqual(f.saves.map(save => save.value.title), ["first", "last", "during-retry"]);
    assert.equal(f.saves[2].baseUpdatedAt, "2030-01-01T00:00:02Z");
    assert.equal(f.useCanvasStore.getState().conflictDrafts.length, 0);
    assert.equal(f.maxInFlight, 1);
    f.release(3);
    await tick();
    assert.equal(f.useCanvasStore.getState().projects[0].title, "during-retry");
    assert.equal(f.useCanvasStore.getState().projects[0].pendingSave, false);
});

test("显式重试再次 409 时保留最新编辑为新草稿，并停止后续自动请求", async () => {
    const f = fixture();
    await conflictDuringSave(f);
    const retry = f.useCanvasStore.getState().retrySaves();
    await tick();
    f.useCanvasStore.getState().renameProject("p", "latest-retry-draft");
    f.fail(conflict());
    f.release(2);
    await retry;
    await f.advance(2500);
    assert.deepEqual(f.saves.map(save => save.value.title), ["first", "last"]);
    assert.equal(f.useCanvasStore.getState().projects[0].title, "remote");
    assert.equal(f.useCanvasStore.getState().conflictDrafts[0]?.title, "latest-retry-draft");
    f.fail(undefined);
    const secondRetry = f.useCanvasStore.getState().retrySaves();
    await tick();
    assert.equal(f.saves[2].value.title, "latest-retry-draft");
    f.release(3);
    await secondRetry;
    assert.equal(f.useCanvasStore.getState().conflictDrafts.length, 0);
});
