import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { canvasFixture, project, tick } from "./test-utils/canvas-store-fixture.mjs";

const lockFile = new URL("../app/(user)/canvas/utils/canvas-writer-lock.ts", import.meta.url);
const baseline = process.env.CANVAS_WRITER_BASELINE;
function sourceAt(path) {
    if (!baseline) return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
    try { return execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return ""; }
}
const pageSource = sourceAt("web/src/app/(user)/canvas/[id]/canvas-client-page.tsx");

function environment({ channel = true, delayedEvents = false, brokenChannel = false } = {}) {
    let now = 1000, sequence = 0;
    const disk = new Map(), tabs = [], timers = new Map();
    const nextId = () => `id-${++sequence}`;
    function tab(session = new Map()) {
        const listeners = new Map(), channels = [];
        const target = {
            addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
            removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
            emit(type, event) { for (const fn of listeners.get(type) || []) fn(event); },
        };
        const dispatch = (other, type, event) => {
            if (delayedEvents) timers.set(++sequence, { fn: () => other.emit(type, event), at: now + 5, tab: other });
            else other.emit(type, event);
        };
        let storageBroken = false;
        const storage = {
            getItem: key => { if (storageBroken) throw new Error("storage disabled"); return disk.get(key) ?? null; },
            setItem(key, value) {
                if (storageBroken) throw new Error("storage disabled");
                const oldValue = disk.get(key) ?? null;
                disk.set(key, value);
                for (const other of tabs) if (other !== target) dispatch(other, "storage", { key, oldValue, newValue: value });
            },
            removeItem(key) {
                disk.delete(key);
                for (const other of tabs) if (other !== target) dispatch(other, "storage", { key, newValue: null });
            },
        };
        Object.assign(target, { localStorage: storage, sessionStorage: {
            getItem: key => session.get(key) ?? null,
            setItem: (key, value) => session.set(key, value),
        } });
        tabs.push(target);
        const exports = {};
        if (existsSync(lockFile)) {
            const output = ts.transpileModule(sourceAt("web/src/app/(user)/canvas/utils/canvas-writer-lock.ts"), {
                compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
            }).outputText;
            vm.runInNewContext(output, {
                exports, window: target, console: { ...console, warn() {} }, crypto: { randomUUID: nextId },
                Date: class extends Date { static now() { return now; } },
                setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: now + ms, tab: target }); return id; },
                clearTimeout: id => timers.delete(id),
                setInterval: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: now + ms, ms, tab: target }); return id; },
                clearInterval: id => timers.delete(id),
                BroadcastChannel: channel ? class {
                    constructor(name) { this.name = name; this.onmessage = null; channels.push(this); }
                    postMessage(data) {
                        if (brokenChannel) throw new Error("channel closed");
                        for (const other of tabs) if (other !== target) dispatch(other, "channel", { name: this.name, data });
                    }
                    close() { channels.splice(channels.indexOf(this), 1); }
                } : undefined,
            });
        }
        target.addEventListener("channel", event => {
            for (const c of channels) if (c.name === event.name) c.onmessage?.({ data: event.data });
        });
        return { api: exports, window: target, session, breakStorage: value => { storageBroken = value; }, crash() {
            for (const [id, timer] of timers) if (timer.tab === target) timers.delete(id);
            listeners.clear();
        } };
    }
    function advance(ms) {
        const end = now + ms;
        for (;;) {
            const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            const [id, timer] = next;
            now = timer.at;
            if (timer.ms) timer.at += timer.ms; else timers.delete(id);
            timer.fn();
        }
        now = end;
    }
    function lock(tab, owner = "A", project = "board") {
        assert.equal(typeof tab.api.createCanvasWriterLock, "function", "画板应提供实际运行的多标签页写者锁");
        return tab.api.createCanvasWriterLock(owner, project, () => {});
    }
    return { tab, lock, advance, disk };
}

test("只读窗口的统一保存入口不写画板", () => {
    const marker = "persistCurrentCanvasRef.current = (latestNodes = nodesRef.current) => {";
    const start = pageSource.indexOf(marker) + marker.length;
    assert.ok(start >= marker.length);
    const body = pageSource.slice(start, pageSource.indexOf("\n        };", start));
    let saves = 0;
    const context = {
        projectLoaded: true, restoringProjectRef: { current: false }, loadedProjectRef: { current: { id: "board", ownerId: "A" } },
        projectId: "board", currentCanvasOwnerId: () => "A", console,
        canWriteCanvas: () => false, requireCanvasWriter: () => false,
        writerLock: { canWrite: () => false }, writerLockRef: { current: { canWrite: () => false } },
        lastPersistSignatureRef: {}, signatureProjectRef: {}, lastSaveAttemptAtRef: {},
        canvasPersistSignature: () => "new", latestCanvasStateRef: { current: {} }, viewportRef: { current: {} },
        updateProject: () => { saves++; }, flushCanvasSaves: async () => {}, message: { error() {}, warning() {} },
    };
    vm.runInNewContext(`(function(latestNodes) {${body}})([])`, context);
    assert.equal(saves, 0, "只读窗口 updateProject 调用次数必须为 0");
});

test("同时进入和延迟事件仍只有一个写者，存活心跳不被抢占", () => {
    const env = environment({ delayedEvents: true }), a = env.tab(), b = env.tab();
    const first = env.lock(a), second = env.lock(b);
    env.advance(200);
    assert.equal(Number(first.canWrite()) + Number(second.canWrite()), 1);
    const writer = first.canWrite() ? first : second;
    env.advance(30_000);
    assert.equal(writer.canWrite(), true);
    assert.equal(Number(first.canWrite()) + Number(second.canWrite()), 1);
    first.dispose(); second.dispose();
});

test("Channel 发送失败自动走 storage，存储故障可编辑且恢复后重新仲裁", () => {
    const env = environment({ brokenChannel: true }), a = env.tab(), b = env.tab();
    const first = env.lock(a), second = env.lock(b);
    env.advance(200);
    assert.equal(second.canWrite(), false);
    second.takeOver(); env.advance(200);
    assert.equal(first.canWrite(), false);
    a.breakStorage(true); env.advance(250);
    assert.equal(first.canWrite(), true, "协调故障必须允许编辑，不能永久只读");
    a.breakStorage(false); env.advance(250);
    assert.equal(first.canWrite(), false, "故障恢复后必须服从另一窗口的租约");
    first.dispose(); second.dispose();
});

test("离开前仍以写者身份完成保存，pagehide 释放且 pageshow 可自愈", () => {
    const env = environment(), a = env.tab(), b = env.tab();
    let writes = 0, first;
    first = a.api.createCanvasWriterLock("A", "board", () => {}, () => { if (first.canWrite()) writes++; });
    env.advance(200);
    const second = env.lock(b);
    a.window.emit("pagehide", {});
    assert.equal(writes, 1);
    assert.equal(first.canWrite(), false);
    env.advance(200);
    assert.equal(second.canWrite(), true);
    a.window.emit("pageshow", {});
    assert.equal(first.canWrite(), false);
    second.dispose(); env.advance(200);
    assert.equal(first.canWrite(), true);
    first.dispose();
});

test("离开前保存抛错也必须释放编辑权并清理心跳", () => {
    const env = environment(), a = env.tab(), b = env.tab();
    const first = a.api.createCanvasWriterLock("A", "board", () => {}, () => { throw new Error("save failed"); });
    env.advance(200);
    const second = env.lock(b);
    assert.doesNotThrow(() => first.dispose());
    env.advance(200);
    assert.equal(first.canWrite(), false);
    assert.equal(second.canWrite(), true);
    env.advance(30_000);
    assert.equal(second.canWrite(), true);
    second.dispose();
});

test("离开时等现有最终保存完成后释放，保存挂住也会在租约到期后自愈", async () => {
    for (const hangs of [false, true]) {
        const env = environment(), a = env.tab(), b = env.tab();
        let finishSave;
        const first = a.api.createCanvasWriterLock("A", "board", () => {}, () => new Promise(resolve => { finishSave = resolve; }));
        env.advance(200);
        const second = env.lock(b);
        a.window.emit("pagehide", {});
        assert.equal(first.canWrite(), true, "最终 flush 的异步保存不能被自己释放的锁挡住");
        assert.equal(second.canWrite(), false);
        if (!hangs) { finishSave(); await tick(); }
        else env.advance(10_500);
        env.advance(200);
        assert.equal(first.canWrite(), false);
        assert.equal(second.canWrite(), true);
        first.dispose(); second.dispose();
    }
});

const denyBoard = f => f.localDisk.set('infinite-canvas:writer:["A","board"]', JSON.stringify({ tabId: "other-tab", instanceId: "other-page", at: Date.now() }));

test("真实 store 只读时不更新、不排队、不补传；接管前的排队保存也不发送", async () => {
    const f = canvasFixture({ owner: "A", projects: [project("board")], remote: [project("board")], syncEnabled: true });
    await f.useCanvasStore.persist.rehydrate(); await tick(); f.clearOperations();
    f.useCanvasStore.getState().updateProject("board", { title: "queued-before-loss" });
    denyBoard(f);
    assert.throws(() => f.useCanvasStore.getState().renameProject("board", "denied"), /本窗口为只读/);
    f.useCanvasStore.getState().updateProject("board", { title: "denied" });
    assert.equal(f.useCanvasStore.getState().projects[0].title, "queued-before-loss");
    await f.advance(500); await f.flushCanvasSaves();
    assert.equal(f.requests.filter(([type]) => type === "save" || type === "sync" || type === "delete").length, 0);
    await f.useCanvasStore.getState().syncWithRemote("A-token", true);
    assert.equal(f.requests.filter(([type]) => type === "save" || type === "sync").length, 0);
});

test("失权前排队的本地保存不得覆盖新写者的分键副本", async () => {
    const f = canvasFixture({ owner: "A", projects: [project("board")] });
    await f.useCanvasStore.persist.rehydrate(); await f.flushCanvasSaves();
    f.useCanvasStore.getState().updateProject("board", { title: "stale-queued-edit" });
    denyBoard(f);
    const latest = { ...project("board"), title: "new-writer-latest" };
    f.idbDisk.set("canvas_project:A:board", JSON.stringify(latest));
    f.clearOperations();
    await f.flushCanvasSaves();
    assert.equal(JSON.parse(f.idbDisk.get("canvas_project:A:board")).title, "new-writer-latest");
    assert.equal(f.writes.filter(item => item.key === "canvas_project:A:board").length, 0);
});

test("其他窗口持有的本地未上云画板不补传，也不得从本地列表丢失", async () => {
    const f = canvasFixture({ owner: "A", projects: [project("board")], remote: [], syncEnabled: true });
    denyBoard(f);
    await f.useCanvasStore.persist.rehydrate(); await tick(); f.clearOperations();
    await f.useCanvasStore.getState().syncWithRemote("A-token", true);
    assert.equal(f.useCanvasStore.getState().projects.some(item => item.id === "board"), true);
    assert.equal(f.requests.filter(([type]) => type === "save" || type === "sync").length, 0);
});

test("接管必须读取最新远端画板，匿名则读取最新本地分键，不能保存旧快照", async () => {
    const current = { ...project("board"), title: "latest-writer", nodes: [project("board").nodes[0], { id: "new", type: "text" }] };
    const f = canvasFixture({ owner: "A", projects: [project("board")], remote: [current], syncEnabled: true });
    await f.useCanvasStore.persist.rehydrate(); await tick(); f.clearOperations();
    const loaded = await f.useCanvasStore.getState().loadProject("board", true);
    assert.equal(loaded.nodes.length, 2);
    assert.equal(f.requests.filter(([type]) => type === "get").length, 1);
    assert.equal(f.requests.filter(([type]) => type === "save").length, 0);
    const anon = canvasFixture({ projects: [project("board")] });
    await anon.useCanvasStore.persist.rehydrate(); await anon.flushCanvasSaves();
    anon.idbDisk.set("canvas_project:anon:board", JSON.stringify(current));
    assert.equal((await anon.useCanvasStore.getState().loadProject("board", true)).nodes.length, 2);
});

test("接管刷新不能复用旧请求，旧请求迟到也不能覆盖接管后的最新画板", async () => {
    const f = canvasFixture({ owner: "A", remote: [{ id: "board", title: "board", nodeCount: 1, updatedAt: project("board").updatedAt, hydrated: false }], syncEnabled: true });
    await f.useCanvasStore.persist.rehydrate(); await tick(); f.clearOperations();
    let finishOld;
    f.detailGate(new Promise(resolve => { finishOld = resolve; }));
    const oldRequest = f.useCanvasStore.getState().loadProject("board");
    await tick();
    f.detailGate(Promise.resolve(project("board")));
    const refreshed = await f.useCanvasStore.getState().loadProject("board", true);
    assert.equal(refreshed.id, "board");
    assert.equal(f.requests.filter(([type]) => type === "get").length, 2);
    finishOld({ ...project("board"), title: "stale" });
    assert.equal(await oldRequest, null);
    assert.notEqual(f.useCanvasStore.getState().projects[0].title, "stale");
});

test("只读界面接入可见横幅和接管；编辑、Agent 和生成均检查实际写权", () => {
    for (const fragment of [
        "该画板已在另一个窗口打开，本窗口为只读", "在此窗口接管编辑", "writerLock.takeOver",
        "多窗口保护暂不可用", "readOnly={readOnly}", "canWrite={canWriteCanvas}", "writerLock.resume()",
    ]) assert.ok(pageSource.includes(fragment), fragment);
    const ast = ts.createSourceFile("page.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const methods = new Map();
    const visit = node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer?.getText(ast).startsWith("useCallback(")) methods.set(node.name.text, node.initializer.getText(ast));
        ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const name of ["handleGenerateNode", "executeCanvasAgentAction", "createNode", "deleteNodes", "handleNodeContentChange", "handleDrop", "handleUploadRequest", "handleRetryNode"]) {
        assert.ok(methods.get(name)?.includes("if (!requireCanvasWriter())"), `${name} 必须先阻止只读写操作`);
    }
    const panel = readFileSync(new URL("../app/(user)/canvas/components/canvas-assistant-panel.tsx", import.meta.url), "utf8");
    assert.ok(panel.includes("if (readOnly || canWrite?.() === false)"), "Agent 请求前须检查实时锁");
    assert.ok(panel.includes('readOnly ? <p role="status"'), "只读不能展示可提交的 Agent 输入框");
});

test("只读时执行真实编辑及生成回调均不改节点、不发请求且有提示", async () => {
    const ast = ts.createSourceFile("page.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const callbacks = new Map();
    const visit = node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer?.getText(ast).startsWith("useCallback(")) callbacks.set(node.name.text, node.initializer.arguments[0].getText(ast));
        ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const name of ["handleGenerateNode", "executeCanvasAgentAction", "handleRetryNode", "createNode", "deleteNodes", "handleNodeContentChange", "createImageFileNode", "createVideoFileNode", "createAudioFileNode", "importFiles", "duplicateNode", "toggleNodeFreeResize", "setBatchPrimary", "captureVideoNodeFrame", "createImageReversePromptNodes", "cropImageNode", "splitImageNode", "upscaleImageNode", "generateImageFromTextNode", "handleDirectorCapturesSent", "handleDirectorVideoSent"]) {
        let notices = 0, requests = 0, edits = 0;
        const compiled = ts.transpileModule(`(${callbacks.get(name)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
        const fn = vm.runInNewContext(compiled, {
            requireCanvasWriter: () => { notices++; return false; },
            setNodes: () => { edits++; },
            uploadImage: async () => { requests++; },
            uploadMediaFile: async () => { requests++; },
            submitCanvasImageRequest: async () => { requests++; },
            submitCanvasVideoRequest: async () => { requests++; },
        });
        await fn({});
        assert.equal(notices, 1, `${name}: 拒绝操作必须有可见提示`);
        assert.equal(edits, 0, `${name}: 不得先编辑再回滚`);
        assert.equal(requests, 0, `${name}: 只读不得发生成或上传请求`);
    }
});

test("心跳超时后自愈，接管使原窗口立即失去写权", () => {
    const env = environment(), a = env.tab(), b = env.tab();
    const first = env.lock(a);
    env.advance(200);
    const second = env.lock(b);
    env.advance(200);
    assert.equal(first.canWrite(), true);
    assert.equal(second.canWrite(), false);
    second.takeOver();
    env.advance(200);
    assert.equal(first.canWrite(), false);
    assert.equal(second.canWrite(), true);
    b.crash();
    env.advance(10_500);
    assert.equal(first.canWrite(), true, "写者崩溃后只等一个租约周期");
    first.dispose();
});

test("锁按账号及画板隔离，刷新保留 tabId，复制标签页重新分配 tabId", () => {
    const env = environment(), a = env.tab(), b = env.tab();
    const first = env.lock(a), otherAccount = env.lock(b, "B"), otherBoard = env.lock(b, "A", "other");
    env.advance(200);
    assert.equal(first.canWrite(), true);
    assert.equal(otherAccount.canWrite(), true);
    assert.equal(otherBoard.canWrite(), true);
    const session = new Map(a.session);
    const duplicate = env.tab(new Map(session));
    const copy = env.lock(duplicate);
    env.advance(200);
    assert.equal(copy.canWrite(), false);
    assert.notEqual(duplicate.api.canvasWriterTabId(), a.api.canvasWriterTabId());
    const differentBoardCopy = env.tab(new Map(session));
    const otherCopy = env.lock(differentBoardCopy, "A", "third");
    env.advance(200);
    assert.equal(otherCopy.canWrite(), true);
    assert.notEqual(differentBoardCopy.api.canvasWriterTabId(), a.api.canvasWriterTabId());
    first.dispose();
    const reloaded = env.tab(session);
    assert.equal(reloaded.api.canvasWriterTabId(), a.api.canvasWriterTabId());
    copy.dispose(); otherCopy.dispose(); otherAccount.dispose(); otherBoard.dispose();
});

test("BroadcastChannel 不可用仍通过 storage 事件接管与释放", () => {
    const env = environment({ channel: false }), a = env.tab(), b = env.tab();
    const first = env.lock(a);
    env.advance(200);
    const second = env.lock(b);
    env.advance(200);
    assert.equal(second.canWrite(), false);
    second.takeOver();
    env.advance(200);
    assert.equal(first.canWrite(), false);
    assert.equal(second.canWrite(), true);
    second.dispose();
    env.advance(200);
    assert.equal(first.canWrite(), true);
    first.dispose();
});
