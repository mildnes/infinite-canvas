import assert from "node:assert/strict";
import test from "node:test";

import { storageKeyFromContentUrl } from "./storage-reference.ts";

test("从历史内容地址恢复云存储引用", () => {
    assert.equal(storageKeyFromContentUrl("/api/files/abc-123/content"), "server:abc-123");
    assert.equal(storageKeyFromContentUrl("https://canvas.example/api/files/webdav%3Aasset.wav/content?download=1"), "server:webdav:asset.wav");
    assert.equal(storageKeyFromContentUrl("https://cdn.example/asset.wav"), "");
});
