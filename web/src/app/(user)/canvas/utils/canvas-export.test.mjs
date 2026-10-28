import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const baseline = process.env.CANVAS_EXPORT_BASELINE;
const sourcePath = "web/src/app/(user)/canvas/utils/canvas-export.ts";
const require = createRequire(import.meta.url);

function sourceAt(path) {
    if (baseline) {
        return execFileSync("git", ["show", `${baseline}:${path}`], {
            cwd: new URL("../../../../../..", import.meta.url),
            encoding: "utf8",
        });
    }
    return readFileSync(new URL(`./${path.split("/").at(-1)}`, import.meta.url), "utf8");
}

function fixture({ failServerId = "", localImage = false, imageBlobs = [], mediaBlobs = [], realZip = false } = {}) {
    const zipFiles = [];
    const saved = [];
    const fetchCalls = [];
    const imageWrites = [];
    const mediaWrites = [];
    const imageReads = [];
    const mediaReads = [];
    const imageBlob = new Blob(["local-image"], { type: "image/png" });
    const serverBlob = new Blob(["server-image"], { type: "image/jpeg" });
    const images = new Map(imageBlobs);
    const media = new Map(mediaBlobs);
    if (localImage) images.set("image:local", imageBlob);
    const zip = {};
    if (realZip) {
        const zipSource = readFileSync(new URL("../../../../lib/zip.ts", import.meta.url), "utf8");
        vm.runInNewContext(ts.transpileModule(zipSource, {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
        }).outputText, { exports: zip, require, Blob, Uint8Array, Map });
    }
    const source = sourceAt(sourcePath);
    const output = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
        },
    }).outputText;
    const exports = {};
    vm.runInNewContext(output, {
        Blob,
        URL,
        console,
        exports,
        fetch: async (url, init) => {
            fetchCalls.push({ url, init });
            const id = decodeURIComponent(String(url).match(/\/api\/files\/([^/]+)\/content$/)?.[1] || "");
            if (id === failServerId) {
                return { ok: false, status: 404, blob: async () => new Blob(["missing"]) };
            }
            return { ok: true, status: 200, blob: async () => serverBlob };
        },
        require: (name) => {
            if (name === "file-saver") return { saveAs: (blob, name) => saved.push({ blob, name }) };
            if (name === "@/lib/zip") return { createZip: async (files) => { zipFiles.push(...files); return realZip ? zip.createZip(files) : new Blob(["zip"]); } };
            if (name === "@/services/file-storage") {
                return {
                    getMediaBlob: async storageKey => { mediaReads.push(storageKey); return media.get(storageKey) ?? null; },
                    setMediaBlob: async (storageKey, blob) => { mediaWrites.push({ storageKey, blob }); media.set(storageKey, blob); },
                };
            }
            if (name === "@/services/image-storage") {
                return {
                    getImageBlob: async storageKey => { imageReads.push(storageKey); return images.get(storageKey) ?? null; },
                    setImageBlob: async (storageKey, blob) => { imageWrites.push({ storageKey, blob }); images.set(storageKey, blob); },
                };
            }
            if (name === "../export-types") return {};
            if (name === "../stores/use-canvas-store") return {};
            if (name === "./canvas-project-hydration") return { isCanvasProjectHydrated: () => true };
            if (name === "@/stores/use-user-store") return { useUserStore: { getState: () => ({ token: "token-1" }) } };
            throw new Error(`unexpected require: ${name}`);
        },
    });
    return { exports, zip, zipFiles, saved, fetchCalls, imageWrites, mediaWrites, imageReads, mediaReads, images, media };
}

function projectWithKeys(keys) {
    return {
        id: "project-1",
        title: "测试画板",
        nodes: keys.map((storageKey, index) => ({
            id: `node-${index}`,
            metadata: { storageKey },
        })),
        connections: [],
    };
}

test("云端素材通过 content 接口下载并写入 ZIP 与 projects.json", async () => {
    const f = fixture();
    const result = await f.exports.exportCanvasProjects([projectWithKeys(["server:s1", "server:s2"])], "备份");
    assert.equal(f.fetchCalls.length, 2, "两个云端素材都应下载");
    assert.ok(f.fetchCalls.every(({ url, init }) => String(url).startsWith("/api/files/") && String(url).endsWith("/content") && init.headers.Authorization === "Bearer token-1"));
    const names = f.zipFiles.map((file) => file.name);
    assert.ok(names.includes("projects/project-1/files/s1.jpg"));
    assert.ok(names.includes("projects/project-1/files/s2.jpg"));
    const projectsJson = JSON.parse(f.zipFiles.find((file) => file.name === "projects.json").data);
    assert.deepEqual(
        projectsJson.projects[0].files.map((file) => file.storageKey).sort(),
        ["server:s1", "server:s2"],
    );
    assert.equal(result.cloudAssetCount, 2);
    assert.equal(result.missing.length, 0);
    assert.equal(f.saved.length, 1);
});

test("单个云端素材 404 不中断导出，并返回可见缺失清单", async () => {
    const f = fixture({ failServerId: "s2" });
    const result = await f.exports.exportCanvasProjects([projectWithKeys(["server:s1", "server:s2"])]);
    assert.ok(f.zipFiles.some((file) => file.name === "projects/project-1/files/s1.jpg"));
    assert.ok(!f.zipFiles.some((file) => file.name === "projects/project-1/files/s2.jpg"));
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].storageKey, "server:s2");
    assert.match(result.missing[0].reason, /404/);
    assert.equal(f.saved.length, 1);
});

test("本地 image: 素材仍从图片存储读取且不访问云端", async () => {
    const f = fixture({ localImage: true });
    const result = await f.exports.exportCanvasProjects([projectWithKeys(["image:local"])]);
    assert.equal(f.fetchCalls.length, 0);
    assert.ok(f.zipFiles.some((file) => file.name === "projects/project-1/files/image_local.png"));
    assert.equal(result.missing.length, 0);
});

test("聊天消息中的本地图片和媒体引用写入 ZIP，重复引用只读取一次", async () => {
    const f = fixture({
        imageBlobs: [["image:chat", new Blob(["chat-image"], { type: "image/webp" })]],
        mediaBlobs: [["workflow-video:chat", new Blob(["chat-video"], { type: "video/mp4" })]],
    });
    const project = { ...projectWithKeys([]), chatSessions: [{ messages: [{
        references: [{ storageKey: "image:chat" }, { storageKey: "workflow-video:chat" }],
        images: [{ storageKey: "image:chat" }],
    }] }] };
    const result = await f.exports.exportCanvasProjects([project]);
    assert.equal(f.fetchCalls.length, 0);
    assert.deepEqual(f.imageReads, ["image:chat"]);
    assert.deepEqual(f.mediaReads, ["workflow-video:chat"]);
    assert.ok(f.zipFiles.some(file => file.name === "projects/project-1/files/image_chat.webp"));
    assert.ok(f.zipFiles.some(file => file.name === "projects/project-1/files/workflow-video_chat.mp4"));
    assert.equal(result.missing.length, 0);
});

test("支持的本地媒体素材写入 ZIP，缺失素材返回可见清单", async () => {
    const f = fixture({ mediaBlobs: [["workflow-audio:local", new Blob(["local-audio"], { type: "audio/mpeg" })]] });
    const result = await f.exports.exportCanvasProjects([projectWithKeys(["workflow-audio:local", "audio:missing"])]);
    assert.deepEqual(f.mediaReads.sort(), ["audio:missing", "workflow-audio:local"]);
    assert.ok(f.zipFiles.some(file => file.name === "projects/project-1/files/workflow-audio_local.bin"));
    assert.deepEqual(JSON.parse(JSON.stringify(result.missing)), [{ storageKey: "audio:missing", reason: "本地素材不存在" }]);
    assert.equal(f.saved.length, 1, "已存在的本地素材仍应保存");
});

test("本地图片缺失会返回可供卡片和列表显示的错误", async () => {
    const f = fixture();
    const result = await f.exports.exportCanvasProjects([projectWithKeys(["image:missing"])]);
    assert.equal(f.fetchCalls.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(result.missing)), [{ storageKey: "image:missing", reason: "本地素材不存在" }]);
    const data = JSON.parse(f.zipFiles.find(file => file.name === "projects.json").data);
    assert.equal(data.projects[0].files.length, 0);
});

test("混合云端、节点本地媒体和聊天本地图片的真实 ZIP 可经 v3 导入还原", async () => {
    const f = fixture({
        realZip: true,
        imageBlobs: [["image:chat", new Blob(["chat-image-bytes"], { type: "image/png" })]],
        mediaBlobs: [["audio:node", new Blob(["node-audio-bytes"], { type: "audio/wav" })]],
    });
    const project = {
        ...projectWithKeys(["server:cloud", "audio:node"]),
        chatSessions: [{ messages: [{ references: [{ storageKey: "image:chat" }], images: [{ storageKey: "image:chat" }] }] }],
    };
    const result = await f.exports.exportCanvasProjects([project], "混合素材");
    assert.equal(result.missing.length, 0);
    assert.equal(result.cloudAssetCount, 1);
    assert.equal(f.saved[0].name, "混合素材.zip");
    const archive = await f.zip.readZip(f.saved[0].blob);
    const data = JSON.parse(await archive.get("projects.json").text());
    assert.equal(data.version, 3);
    assert.deepEqual(data.projects[0].files.map(file => file.storageKey).sort(), ["audio:node", "image:chat", "server:cloud"]);
    const exportedByKey = new Map(data.projects[0].files.map(file => [file.storageKey, file]));
    assert.equal(await archive.get(exportedByKey.get("image:chat").path).text(), "chat-image-bytes");
    assert.equal(await archive.get(exportedByKey.get("audio:node").path).text(), "node-audio-bytes");
    assert.equal(await archive.get(exportedByKey.get("server:cloud").path).text(), "server-image");
    f.images.clear();
    f.media.clear();
    const page = readFileSync(new URL("../page.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let importCallback;
    const visit = node => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "importCanvas") importCallback = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(importCallback, "应找到页面实际使用的导入回调");
    const imported = [], notices = [];
    const inputRef = { current: { value: "selected.zip" } };
    const importCanvas = vm.runInNewContext(ts.transpileModule(`(${importCallback})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText, {
        readZip: f.zip.readZip,
        restoreCanvasExportAsset: f.exports.restoreCanvasExportAsset,
        importProject: value => imported.push(value),
        message: { success: text => notices.push(text), error: text => assert.fail(text) },
        inputRef,
    });
    await importCanvas(f.saved[0].blob);
    assert.deepEqual(JSON.parse(JSON.stringify(imported)), [project]);
    assert.equal(await f.images.get("image:chat").text(), "chat-image-bytes");
    assert.equal(f.images.get("image:chat").type, "image/png");
    assert.equal(await f.media.get("audio:node").text(), "node-audio-bytes");
    assert.equal(f.media.get("audio:node").type, "audio/wav");
    assert.ok(!f.images.has("server:cloud") && !f.media.has("server:cloud"), "云端引用保持原有导入语义");
    assert.deepEqual(notices, ["已导入 1 个画布"]);
    assert.equal(inputRef.current.value, "");
});

test("导入时 server: 保持云端引用，image: 才写入本地图片存储", async () => {
    const f = fixture();
    assert.equal(typeof f.exports.restoreCanvasExportAsset, "function", "应导出导入素材还原函数");
    const serverBlob = new Blob(["server"], { type: "image/png" });
    const localBlob = new Blob(["local"], { type: "image/png" });
    assert.equal(await f.exports.restoreCanvasExportAsset({ storageKey: "server:s1", mimeType: "image/png" }, serverBlob), false);
    assert.equal(f.imageWrites.length, 0);
    assert.equal(f.mediaWrites.length, 0);
    assert.equal(await f.exports.restoreCanvasExportAsset({ storageKey: "image:local", mimeType: "image/png" }, localBlob), true);
    assert.equal(f.imageWrites.length, 1);
    assert.equal(f.imageWrites[0].storageKey, "image:local");
});

test("画布导入页通过共享还原函数处理素材前缀", () => {
    const page = readFileSync(new URL("../page.tsx", import.meta.url), "utf8");
    assert.ok(page.includes("restoreCanvasExportAsset(item, blob)"), "导入页应调用共享前缀分流函数");
    assert.ok(!page.includes("setMediaBlob(item.storageKey"), "导入页不应把所有非 image 前缀写成本地媒体");
});
