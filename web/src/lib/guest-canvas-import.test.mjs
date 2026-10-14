import assert from "node:assert/strict";
import test from "node:test";

import { readAnonymousCanvasProjects, guestCanvasImportCandidates, rewriteGuestCanvasReferences, importGuestCanvasProjects } from "./guest-canvas-import.ts";

const project = (id, nodes = []) => ({ id, title: id, nodes, connections: [], chatSessions: [] });
const session = { ownerId: "account-A", token: "A-token" };

test("游客导入明确读取 :anon，裸键及其他账号永不读取，源数据保持不变", async () => {
    const source = JSON.stringify({ state: { ownerUserId: "anon", projects: [project("guest")] }, version: 0 });
    const keys = [];
    const projects = await readAnonymousCanvasProjects(async key => { keys.push(key); return source; });
    assert.deepEqual(keys, ["infinite-canvas:canvas_store:anon"]);
    assert.deepEqual(projects.map(item => item.id), ["guest"]);
    assert.equal(source, JSON.stringify({ state: { ownerUserId: "anon", projects: [project("guest")] }, version: 0 }));
    assert.deepEqual(await readAnonymousCanvasProjects(async () => JSON.stringify({ state: { ownerUserId: "account-B", projects: [project("B")] } })), []);
});

test("按项目 ID 去重，已成功导入的 ID 和账号已有项目不再次迁移", () => {
    assert.deepEqual(guestCanvasImportCandidates([project("one"), project("one"), project("done"), project("existing")], ["done", "existing"]).map(item => item.id), ["one"]);
});

test("以 storageKey 为真源重写六种内容形态及助手图片，不污染匿名原件", async () => {
    const refs = ["", "blob:expired", "data:image/png;base64,AAAA", "https://old.example/image", "/api/files/old/content", "server:old"];
    const source = project("guest", refs.map((content, index) => ({ id: String(index), type: "image", metadata: { storageKey: "image:local", content, originalUrl: content, prompt: "保留提示词" } })));
    source.chatSessions = [{ images: [{ storageKey: "image:local", dataUrl: "blob:old" }] }];
    let resolves = 0;
    const next = await rewriteGuestCanvasReferences(source, async key => { resolves++; assert.equal(key, "image:local"); return { storageKey: "server:new", url: "/api/files/new/content" }; });
    assert.equal(resolves, 1);
    for (const node of next.nodes) {
        assert.equal(node.metadata.storageKey, "server:new");
        assert.equal(node.metadata.content, "/api/files/new/content");
        assert.equal(node.metadata.originalUrl, "/api/files/new/content");
        assert.equal(node.metadata.prompt, "保留提示词");
    }
    assert.equal(next.chatSessions[0].images[0].dataUrl, "/api/files/new/content");
    assert.equal(source.nodes[1].metadata.content, "blob:expired");
    assert.equal(source.chatSessions[0].images[0].storageKey, "image:local");
});

test("缺少可恢复存储键的临时媒体阻止成功回执，保留原件供恢复后重试", async () => {
    const source = project("guest", [{ id: "image", type: "image", metadata: { content: "blob:expired" } }]);
    await assert.rejects(rewriteGuestCanvasReferences(source, async () => { throw new Error("不应上传未知存储键"); }), /媒体缺少可恢复的存储引用/);
    assert.equal(source.nodes[0].metadata.content, "blob:expired");
    const text = project("text", [{ id: "text", type: "text", metadata: { content: "data:image/png;base64,这是用户文字" } }]);
    assert.deepEqual(await rewriteGuestCanvasReferences(text, async () => { throw new Error("不应处理文字"); }), text);
});

function fixture() {
    const remote = [], local = [], completed = [], progress = [], calls = [];
    let current = session, failed = "bad";
    const deps = {
        currentSession: () => current,
        listProjects: async () => remote,
        currentProjects: () => local,
        rewriteProject: async item => { if (item.id === failed) throw new Error("媒体上传失败"); return item; },
        saveProject: async item => { calls.push(["save", item.id]); remote.push(item); return item; },
        commitProject: async item => { calls.push(["commit", item.id]); local.push(item); },
        markComplete: async ids => { completed.push(...ids.filter(id => !completed.includes(id))); },
        onProgress: value => progress.push({ ...value }),
    };
    return { deps, remote, local, completed, progress, calls, switchOwner: () => { current = { ownerId: "account-B", token: "B-token" }; }, recover: () => { failed = ""; } };
}

test("进度逐项更新，失败隔离；重试只补失败项目，匿名数据不删除", async () => {
    const f = fixture(), source = [project("good"), project("bad"), project("good")];
    const first = await importGuestCanvasProjects(source, session, f.deps);
    assert.equal(first.imported, 1);
    assert.equal(first.failed, 1);
    assert.equal(first.completed, 2);
    assert.equal(first.total, 2);
    assert.match(first.errors[0].message, /媒体上传失败/);
    assert.deepEqual(f.completed, ["good"]);
    assert.deepEqual(source.map(item => item.id), ["good", "bad", "good"]);
    f.recover();
    const retry = await importGuestCanvasProjects(source, session, f.deps);
    assert.equal(retry.imported, 1);
    assert.equal(retry.skipped, 1);
    assert.deepEqual(f.calls.filter(([kind]) => kind === "save"), [["save", "good"], ["save", "bad"]]);
    assert.deepEqual(f.completed, ["good", "bad"]);
    assert.deepEqual(f.progress.map(value => value.completed), [0, 1, 2, 0, 1, 2]);
});

test("写入前切号中止：不向新账号写项目或幂等标记", async () => {
    const f = fixture();
    f.deps.rewriteProject = async item => { f.switchOwner(); return item; };
    await assert.rejects(importGuestCanvasProjects([project("guest")], session, f.deps), /登录状态已变化/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.completed, []);
});

test("远端写入后切号中止：不污染新账号内存与本地完成标记", async () => {
    const f = fixture();
    f.deps.saveProject = async item => { f.switchOwner(); return item; };
    await assert.rejects(importGuestCanvasProjects([project("guest")], session, f.deps), /登录状态已变化/);
    assert.deepEqual(f.local, []);
    assert.deepEqual(f.completed, []);
});

test("本地写入后切号也拦住完成标记，失败不误记为成功", async () => {
    const f = fixture();
    f.deps.commitProject = async () => { f.switchOwner(); };
    await assert.rejects(importGuestCanvasProjects([project("guest")], session, f.deps), /登录状态已变化/);
    assert.deepEqual(f.completed, []);
});
