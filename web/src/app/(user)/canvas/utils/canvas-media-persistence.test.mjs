import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCanvasMediaRefForPersistence, repairCanvasMediaRef, sanitizeCanvasNodeForPersistence } from "./canvas-media-persistence.ts";

test("仅 originalUrl 含内联媒体时也写回短引用，保留已有内容和状态", () => {
    for (const originalUrl of ["data:image/png;base64,AAAA", "blob:https://canvas.example/image", "  data:image/png;base64,AAAA  "]) {
        const node = { id: "image", type: "image", metadata: { content: "/api/files/object/content", storageKey: "server:object", originalUrl, mediaStatus: "ok", status: "success", prompt: "保留提示词" } };
        const sanitized = sanitizeCanvasNodeForPersistence(node);
        assert.notEqual(sanitized, node);
        assert.deepEqual(sanitized.metadata, { ...node.metadata, originalUrl: "/api/files/object/content", mediaError: undefined });
        assert.doesNotMatch(JSON.stringify(sanitized), /data:|blob:/);
        assert.equal(node.metadata.originalUrl, originalUrl);
        assert.equal(sanitizeCanvasNodeForPersistence(sanitized), sanitized);
    }
});

test("未上云的内联 originalUrl 不写入保存数据，也不改变可恢复的本地键", () => {
    for (const storageKey of ["", "image:local", "audio:local"]) {
        const sanitized = sanitizeCanvasNodeForPersistence({ type: "image", metadata: { content: "/api/retained", storageKey, originalUrl: "data:image/png;base64,AAAA", mediaStatus: "ok" } });
        assert.equal(sanitized.metadata.originalUrl, "");
        assert.equal(sanitized.metadata.content, "/api/retained");
        assert.equal(sanitized.metadata.storageKey, storageKey);
        assert.equal(sanitized.metadata.mediaStatus, "ok");
    }
});

test("HTTP、API 和 server 原始引用保持不变", () => {
    for (const originalUrl of ["http://images.example/a.png", "https://images.example/a.png", "/api/files/object/content", "server:object"]) {
        const ref = normalizeCanvasMediaRefForPersistence({ content: "/api/files/object/content", storageKey: "server:object", originalUrl });
        assert.equal(ref.originalUrl, originalUrl);
    }
});

test("content 与 originalUrl 同时内联时共用存储短引用", () => {
    const ref = normalizeCanvasMediaRefForPersistence({ content: "data:image/png;base64,AAAA", originalUrl: "data:image/png;base64,AAAA", storageKey: "server:object" });
    assert.equal(ref.content, "/api/files/object/content");
    assert.equal(ref.originalUrl, ref.content);
    assert.equal(ref.mediaStatus, "ok");
});

test("已持久化媒体恢复时只清洗 originalUrl 不产生重复上传或 changed", async () => {
    for (const originalUrl of ["data:image/png;base64,AAAA", "/api/files/object/content"]) {
        const result = await repairCanvasMediaRef({ content: "/api/files/object/content", storageKey: "server:object", originalUrl, mediaStatus: "ok" }, "image", { allowUpload: false });
        assert.equal(result.changed, false);
        assert.equal(result.uploaded, false);
        assert.equal(result.ref.content, "/api/files/object/content");
    }
});
