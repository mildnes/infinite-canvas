import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const baseline = process.env.CANVAS_EXPORT_BASELINE;
const sourcePath = "web/src/app/(user)/canvas/utils/canvas-export.ts";

function sourceAt(path) {
    if (baseline) {
        return execFileSync("git", ["show", `${baseline}:${path}`], {
            cwd: new URL("../../../../../..", import.meta.url),
            encoding: "utf8",
        });
    }
    return readFileSync(new URL(`./${path.split("/").at(-1)}`, import.meta.url), "utf8");
}

function fixture({ failServerId = "", localImage = false } = {}) {
    const zipFiles = [];
    const saved = [];
    const fetchCalls = [];
    const imageWrites = [];
    const mediaWrites = [];
    const imageBlob = new Blob(["local-image"], { type: "image/png" });
    const serverBlob = new Blob(["server-image"], { type: "image/jpeg" });
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
            if (name === "@/lib/zip") return { createZip: async (files) => { zipFiles.push(...files); return new Blob(["zip"]); } };
            if (name === "@/services/file-storage") {
                return {
                    getMediaBlob: async () => null,
                    setMediaBlob: async (storageKey, blob) => { mediaWrites.push({ storageKey, blob }); },
                };
            }
            if (name === "@/services/image-storage") {
                return {
                    getImageBlob: async () => localImage ? imageBlob : null,
                    setImageBlob: async (storageKey, blob) => { imageWrites.push({ storageKey, blob }); },
                };
            }
            if (name === "../export-types") return {};
            if (name === "../stores/use-canvas-store") return {};
            if (name === "./canvas-project-hydration") return { isCanvasProjectHydrated: () => true };
            if (name === "@/stores/use-user-store") return { useUserStore: { getState: () => ({ token: "token-1" }) } };
            throw new Error(`unexpected require: ${name}`);
        },
    });
    return { exports, zipFiles, saved, fetchCalls, imageWrites, mediaWrites };
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
