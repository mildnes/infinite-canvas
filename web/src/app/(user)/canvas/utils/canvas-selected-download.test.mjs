import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { unzipSync, zipSync } from "fflate";

const baseline = process.env.CANVAS_DOWNLOAD_BASELINE;
const pagePath = "web/src/app/(user)/canvas/[id]/canvas-client-page.tsx";
const downloadPath = "web/src/app/(user)/canvas/utils/canvas-selected-download.ts";

function sourceAt(path) {
    if (baseline) {
        return execFileSync("git", ["show", `${baseline}:${path}`], {
            cwd: new URL("../../../../../..", import.meta.url),
            encoding: "utf8",
        });
    }
    if (path === pagePath) return readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
    return readFileSync(new URL(`./${path.split("/").at(-1)}`, import.meta.url), "utf8");
}

const pageSource = sourceAt(pagePath);

function fixture({ missing = new Set(), localImages = new Map(), localMedia = new Map() } = {}) {
    const saved = [];
    const zipCalls = [];
    const fetchCalls = [];
    const exports = {};
    const source = readFileSync(new URL(`./${downloadPath.split("/").at(-1)}`, import.meta.url), "utf8");
    const output = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
        },
    }).outputText;

    vm.runInNewContext(output, {
        Blob,
        URL,
        Date,
        encodeURIComponent,
        fetch: async (url, init) => {
            fetchCalls.push({ url, init });
            const id = decodeURIComponent(String(url).match(/\/api\/files\/([^/]+)\/content$/)?.[1] || "");
            if (missing.has(id)) return { ok: false, status: 404, blob: async () => new Blob([]) };
            return { ok: true, status: 200, blob: async () => new Blob([id || String(url)], { type: "image/png" }) };
        },
        exports,
        require: (name) => {
            if (name === "file-saver") return { saveAs: (blob, name) => saved.push({ blob, name }) };
            if (name === "@/lib/zip") return {
                createZip: async (files) => {
                    zipCalls.push(files);
                    const entries = await Promise.all(files.map(async (file) => [
                        file.name,
                        new Uint8Array(await new Blob([file.data]).arrayBuffer()),
                    ]));
                    return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: "application/zip" });
                },
            };
            if (name === "@/services/file-storage") return {
                getMediaBlob: async (key) => localMedia.get(key) || null,
            };
            if (name === "@/services/image-storage") return {
                getImageBlob: async (key) => localImages.get(key) || null,
            };
            throw new Error(`unexpected require: ${name}`);
        },
    });
    return { exports, saved, zipCalls, fetchCalls };
}

function mediaNode(id, type = "image", metadata = {}) {
    return {
        id,
        type,
        title: `节点 ${id}`,
        metadata: { content: "", storageKey: "", mimeType: "image/png", ...metadata },
    };
}

function download(f, options) {
    const selection = f.exports.prepareCanvasNodeDownloadSelection(options.nodes, options.selectedNodeIds);
    return f.exports.downloadSelectedCanvasNodes(selection, options);
}

test("工具栏在有选中节点时接入批量下载回调，未选中时沿用条件渲染", () => {
    assert.ok(/onDownloadSelected=\{downloadSelectedNodes\}/.test(pageSource), "画板页应把批量下载处理器传给工具栏");
    const toolbar = readFileSync(new URL("../components/canvas-toolbar.tsx", import.meta.url), "utf8");
    assert.ok(/selectedCount\s*\?\s*\([\s\S]*?onDownloadSelected\s*\?\s*\([\s\S]*?id="tool-download"/.test(toolbar));
});

test("单个云端图片直接保存且文件名与单节点下载一致", async () => {
    const f = fixture();
    const result = await download(f, {
        nodes: [mediaNode("image-123", "image", { content: "/api/files/object-1/content", storageKey: "server:object-1", mimeType: "image/png" })],
        selectedNodeIds: new Set(["image-123"]),
        token: "current-token",
        projectTitle: "画板",
        now: new Date(2026, 9, 26, 15, 8, 0),
    });
    assert.equal(f.fetchCalls.length, 1);
    assert.equal(f.fetchCalls[0].init.headers.Authorization, "Bearer current-token");
    assert.equal(f.zipCalls.length, 0, "单节点下载不应打包");
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].name, "canvas-image-image-123.png");
    assert.equal(result.downloadedCount, 1);
});

test("六张同提示词图片打成六个唯一节点名条目且素材字节各自保留", async () => {
    const f = fixture();
    const nodes = Array.from({ length: 6 }, (_, index) => mediaNode(`image-${index + 1}`, "image", {
        content: `/api/files/object-${index + 1}/content`,
        storageKey: `server:object-${index + 1}`,
        prompt: "相同提示词",
    }));
    const result = await download(f, {
        nodes,
        selectedNodeIds: new Set(nodes.map((node) => node.id)),
        token: "current-token",
        projectTitle: "批量画板",
        now: new Date(2026, 9, 26, 15, 8, 0),
    });
    assert.equal(f.zipCalls.length, 1);
    const entries = f.zipCalls[0];
    assert.equal(entries.length, 6);
    assert.deepEqual(Array.from(entries.map((entry) => entry.name)).sort(), nodes.map((node) => `canvas-image-${node.id}.png`).sort());
    assert.equal(new Set(entries.map((entry) => entry.name)).size, 6);
    const archive = unzipSync(new Uint8Array(await f.saved[0].blob.arrayBuffer()));
    assert.equal(Object.keys(archive).length, 6, "真实 ZIP 中必须包含六个条目");
    const byteValues = Object.values(archive).map((bytes) => Buffer.from(bytes).toString("utf8"));
    assert.equal(new Set(byteValues).size, 6, "每个节点文件的内容字节应各不相同");
    assert.equal(f.saved[0].name, "批量画板-选中6个-20261026-1508.zip");
    assert.equal(result.downloadedCount, 6);
});

test("混合选择仅打包图片、视频、音频，跳过文本和空节点并计数", async () => {
    const f = fixture({
        localImages: new Map([["image:local-1", new Blob(["img"], { type: "image/png" })]]),
        localMedia: new Map([
            ["video:local-1", new Blob(["vid"], { type: "video/mp4" })],
            ["audio:local-1", new Blob(["aud"], { type: "audio/wav" })],
        ]),
    });
    const nodes = [
        mediaNode("img", "image", { storageKey: "image:local-1" }),
        mediaNode("vid", "video", { storageKey: "video:local-1", mimeType: "video/mp4" }),
        mediaNode("aud", "audio", { storageKey: "audio:local-1", mimeType: "audio/wav" }),
        mediaNode("text", "text", { content: "正文" }),
        mediaNode("empty", "image"),
    ];
    const result = await download(f, {
        nodes,
        selectedNodeIds: new Set(nodes.map((node) => node.id)),
        token: "",
        projectTitle: "混合",
        now: new Date(2026, 9, 26, 15, 8, 0),
    });
    assert.equal(result.downloadedCount, 3);
    assert.equal(result.skippedCount, 2);
    assert.deepEqual(Array.from(f.zipCalls[0].map((entry) => entry.name)).sort(), [
        "canvas-audio-aud.wav",
        "canvas-image-img.png",
        "canvas-video-vid.mp4",
    ]);
});

test("一个云端素材 404 时其他文件仍打包并返回标题和失败原因", async () => {
    const f = fixture({ missing: new Set(["object-2"]) });
    const nodes = [
        mediaNode("image-1", "image", { storageKey: "server:object-1" }),
        { ...mediaNode("image-2", "image", { storageKey: "server:object-2" }), title: "失败节点" },
        mediaNode("image-3", "image", { storageKey: "server:object-3" }),
    ];
    const result = await download(f, {
        nodes,
        selectedNodeIds: new Set(nodes.map((node) => node.id)),
        token: "token",
        projectTitle: "部分成功",
        now: new Date(2026, 9, 26, 15, 8, 0),
    });
    assert.equal(result.downloadedCount, 2);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].title, "失败节点");
    assert.match(result.failures[0].reason, /404/);
    assert.equal(f.zipCalls[0].length, 2);
});

test("全部素材下载失败时不创建空 ZIP", async () => {
    const f = fixture({ missing: new Set(["gone-1", "gone-2"]) });
    const nodes = [
        mediaNode("image-1", "image", { storageKey: "server:gone-1" }),
        mediaNode("image-2", "image", { storageKey: "server:gone-2" }),
    ];
    const result = await download(f, {
        nodes,
        selectedNodeIds: new Set(nodes.map((node) => node.id)),
        token: "token",
        projectTitle: "全部失败",
        now: new Date(2026, 9, 26, 15, 8, 0),
    });
    assert.equal(result.downloadedCount, 0);
    assert.equal(result.failures.length, 2);
    assert.equal(f.zipCalls.length, 0);
    assert.equal(f.saved.length, 0);
});

test("只读状态仍可执行下载，批量下载处理器不检查画布写权限", () => {
    const start = pageSource.indexOf("const downloadSelectedNodes = useCallback");
    const end = pageSource.indexOf("const disconnectNodeReference", start);
    assert.ok(start >= 0 && end > start, "画板页应定义批量下载处理器");
    const handler = pageSource.slice(start, end);
    assert.ok(!/requireCanvasWriter|canWriteCanvas/.test(handler), "下载不得依赖画板写权限");
});

test("空选择不生成 ZIP；超过五十个媒体节点可由页面提前警告", () => {
    const f = fixture();
    const resultPromise = download(f, {
        nodes: [mediaNode("image-1", "image", { storageKey: "server:1" })],
        selectedNodeIds: new Set(),
        token: "",
        projectTitle: "空选择",
        now: new Date(),
    });
    return resultPromise.then((result) => {
        assert.equal(result.selectedCount, 0);
        assert.equal(f.zipCalls.length, 0);
        assert.equal(f.saved.length, 0);
        assert.match(pageSource, /将打包 \$\{downloadableCount\} 个文件，可能较慢/);
    });
});
