import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { normalizeAsset } from "../lib/asset-data.ts";

function fixture(fail = false) {
    const calls = [], exports = {};
    const code = ts.transpileModule(readFileSync(new URL("./asset-storage.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { exports, File, fetch: async () => ({ ok: true, blob: async () => new Blob(["media"], { type: "video/mp4" }) }), require: name => {
        if (name.endsWith("asset-data")) return { normalizeAsset };
        if (name.endsWith("image-storage")) return { uploadImage: async url => { calls.push(url); if (fail) throw new Error("expired blob"); return { url: "blob:local", storageKey: "image:local", width: 1, height: 2, bytes: 5, mimeType: "image/png" }; } };
        return { uploadAssetMediaFile: async (file, prefix) => { calls.push(prefix); return { url: "blob:local", storageKey: `${prefix}:local`, bytes: file.size, mimeType: file.type }; } };
    } });
    return { prepare: exports.prepareAssetForSave, calls };
}

test("saving live blob media without a key persists bytes first, then strips ephemeral references", async () => {
    const f = fixture();
    for (const kind of ["image", "video", "audio"]) {
        const prepared = await f.prepare({ kind, title: "file", coverUrl: "blob:cover", data: kind === "image" ? { dataUrl: "blob:live" } : { url: "blob:live", mimeType: `${kind}/test` } });
        assert.ok(prepared.data.storageKey);
        assert.ok(!JSON.stringify(prepared).includes("blob:"));
    }
    assert.equal(f.calls.length, 3);
    const canonical = await f.prepare({ kind: "image", coverUrl: "blob:cover", data: { dataUrl: "blob:expired", storageKey: "server:existing" } });
    assert.equal(canonical.data.dataUrl, "/api/files/existing/content");
    assert.equal(f.calls.length, 3, "existing storage keys do not upload media again");
    await assert.rejects(fixture(true).prepare({ kind: "image", data: { dataUrl: "blob:expired" } }), /expired blob/);
});
