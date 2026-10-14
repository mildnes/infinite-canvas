import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as guestImport from "../lib/guest-canvas-import.ts";

const anonymousKey = "infinite-canvas:canvas_store:anon";
const project = (id, storageKey = "image:local") => ({ id, title: id, nodes: [{ id: "image", type: "image", metadata: { content: "blob:expired", dataUrl: "", originalUrl: "data:image/png;base64,AAAA", storageKey } }], connections: [], chatSessions: [] });

function fixture(source = process.env.GUEST_CANVAS_BASELINE
    ? execFileSync("git", ["show", `${process.env.GUEST_CANVAS_BASELINE}:web/src/services/storage-migration.ts`], { encoding: "utf8" })
    : readFileSync(new URL("./storage-migration.ts", import.meta.url), "utf8")) {
    let user = { token: "A-token", user: { id: "A" }, isReady: true };
    let uploadKey = "server:new", afterSave;
    const projects = [], remote = [], operations = [], uploads = [];
    const anon = JSON.stringify({ state: { ownerUserId: "anon", projects: [project("guest")] }, version: 0 });
    const disk = new Map([[anonymousKey, anon], ["infinite-canvas:canvas_store", "untouched legacy"], ["infinite-canvas:canvas_store:B", "untouched B"]]);
    const modules = {
        "localforage": { default: { getItem: async key => { operations.push(["read", key]); return disk.get(key); }, setItem: async (key, value) => { operations.push(["write", key]); disk.set(key, value); } } },
        "@/lib/localforage-storage": { currentStorageOwnerId: () => user.user?.id || "anon" },
        "./image-storage": { getImageBlob: async key => key.startsWith("image:") ? new Blob(["image"], { type: "image/png" }) : null, resolveImageUrl: async () => "", uploadImage: async (_blob, options) => { uploads.push(["image", options.token]); return { storageKey: uploadKey, url: "blob:upload" }; } },
        "./file-storage": { getMediaBlob: async () => null, resolveMediaUrl: async () => "", uploadMediaBlob: async (_blob, _filename, token) => { uploads.push(["media", token]); return { storageKey: uploadKey, url: "blob:upload" }; } },
        "@/app/(user)/canvas/stores/use-canvas-store": { useCanvasStore: { getState: () => ({ ownerUserId: user.user.id, projects, importAccountProjects: async saved => { projects.push(...saved); } }) } },
        "@/stores/use-user-store": { useUserStore: { getState: () => user } },
        "@/lib/guest-canvas-import": guestImport,
        "./api/canvas-tasks": { listCanvasProjects: async () => remote, syncCanvasProjects: async (token, items) => { operations.push(["sync", token]); remote.push(...items); afterSave?.(); return items; } },
    };
    const exports = {};
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
        exports, require: name => modules[name] || {}, Blob, Map, Set, Error, console,
        fetch: async (url, options) => { operations.push(["fetch", url, options?.headers?.Authorization]); return { ok: true, blob: async () => new Blob(["server image"], { type: "image/png" }) }; },
    });
    return { api: exports, disk, operations, uploads, projects, remote, anon, localOnly: () => { uploadKey = "image:still-local"; }, switchAfterSave: () => { afterSave = () => { user = { ...user, token: "B-token", user: { id: "B" } }; }; } };
}

test("真实迁移入口读取匿名持久化画板，当前账号空内存不遮蔽源数据", async () => {
    const f = fixture();
    const items = await f.api.loadGuestCanvasImportProjects("A", "A-token");
    assert.deepEqual(Array.from(items, item => item.id), ["guest"]);
    assert.deepEqual(f.operations.map(item => item[1]), [anonymousKey, "infinite-canvas:guest_canvas_import:A"]);
    assert.equal(f.disk.get("infinite-canvas:canvas_store"), "untouched legacy");
    assert.equal(f.disk.get("infinite-canvas:canvas_store:B"), "untouched B");
});

test("真实迁移把旧 server 媒体字节持久化到登录账号，成功后才写完成标记", async () => {
    const f = fixture();
    const result = await f.api.importAnonymousCanvasProjects([project("guest", "server:old")], "A", "A-token", () => {});
    assert.equal(result.imported, 1);
    assert.deepEqual(f.uploads, [["image", "A-token"]]);
    assert.ok(f.operations.some(item => item[0] === "fetch" && item[1] === "/api/files/old/content" && item[2] === "Bearer A-token"));
    assert.equal(f.projects[0].nodes[0].metadata.content, "/api/files/new/content");
    assert.equal(f.projects[0].nodes[0].metadata.dataUrl, "/api/files/new/content");
    assert.equal(f.projects[0].nodes[0].metadata.originalUrl, "/api/files/new/content");
    assert.deepEqual(Array.from(f.disk.get("infinite-canvas:guest_canvas_import:A")), ["guest"]);
    assert.equal(f.disk.get(anonymousKey), f.anon);
    assert.deepEqual(Array.from(await f.api.loadGuestCanvasImportProjects("A", "A-token")), []);
});

test("云上传回退本地键不算导入成功：不保存空板，源画板可重试", async () => {
    const f = fixture();
    f.localOnly();
    const result = await f.api.importAnonymousCanvasProjects([project("guest")], "A", "A-token", () => {});
    assert.equal(result.failed, 1);
    assert.equal(result.imported, 0);
    assert.match(result.errors[0].message, /账号云存储不可用/);
    assert.equal(f.remote.length, 0);
    assert.equal(f.disk.get(anonymousKey), f.anon);
    assert.equal(f.disk.has("infinite-canvas:guest_canvas_import:A"), false);
});

test("真实远端返回后切号不写新账号内存或任一账号完成标记", async () => {
    const f = fixture();
    f.switchAfterSave();
    await assert.rejects(f.api.importAnonymousCanvasProjects([project("guest")], "A", "A-token", () => {}), /登录状态已变化/);
    assert.equal(f.projects.length, 0);
    assert.equal(f.disk.has("infinite-canvas:guest_canvas_import:A"), false);
    assert.equal(f.disk.has("infinite-canvas:guest_canvas_import:B"), false);
    assert.equal(f.disk.get(anonymousKey), f.anon);
});
