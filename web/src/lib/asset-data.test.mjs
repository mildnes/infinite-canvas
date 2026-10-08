import assert from "node:assert/strict";
import test from "node:test";
import { mergeAssets, mergeAssetSnapshots, normalizeAsset, stableAssetUrl } from "./asset-data.ts";

const now = Date.parse("2030-01-31T12:00:00Z");
const asset = (id, updatedAt = "2030-01-30T12:00:00Z") => ({ id, kind: "image", title: id, coverUrl: "blob:dead", tags: [], createdAt: updatedAt, updatedAt, data: { dataUrl: "", storageKey: `server:${id}`, width: 10, height: 20, bytes: 100, mimeType: "image/png" } });

test("normalization repairs empty/blob server references without mutating media metadata", () => {
    for (const dataUrl of ["", "blob:expired", "/api/files/old/content"]) {
        const original = asset("object");
        original.data.dataUrl = dataUrl;
        const normalized = normalizeAsset(original);
        assert.equal(normalized.data.dataUrl, "/api/files/object/content");
        assert.equal(normalized.coverUrl, normalized.data.dataUrl);
        assert.equal(normalized.data.storageKey, original.data.storageKey);
        assert.equal(original.data.dataUrl, dataUrl);
    }
    for (const kind of ["video", "audio"]) {
        const normalized = normalizeAsset({ ...asset("object"), kind, coverUrl: "data:image/png;base64,stale", data: { url: "blob:expired", storageKey: "server:object", mimeType: `${kind}/test` } });
        assert.equal(normalized.data.url, "/api/files/object/content");
        assert.equal(normalized.coverUrl, "/api/files/object/content");
    }
    assert.equal(stableAssetUrl("image:local", "blob:dead"), "");
    assert.equal(stableAssetUrl("server:webdav:remote", "https://source/image"), "https://source/image");
    assert.equal(stableAssetUrl("server:../invalid", "blob:dead"), "");
    assert.equal(stableAssetUrl(undefined, null), "");
    assert.equal(normalizeAsset({ ...asset("text"), kind: "text", data: { content: "blob: is ordinary text" } }).data.content, "blob: is ordinary text");
});

test("merge keeps both devices' additions, chooses newer edits, and converges independent of ordering", () => {
    const old = asset("same", "2030-01-29T12:00:00Z"), newer = asset("same");
    newer.title = "edited";
    const first = mergeAssets([old, asset("a")], [newer, asset("b")]);
    assert.deepEqual(first.map(item => item.id), ["a", "b", "same"]);
    assert.equal(first.find(item => item.id === "same").title, "edited");
    assert.deepEqual(first, mergeAssets([newer, asset("b")], [old, asset("a")]));
    assert.deepEqual(mergeAssetSnapshots({ assets: first }, { assets: first }, now).assets, first);
});

test("newer/tied tombstones suppress stale assets, newer explicit edits survive, and tombstones expire after 30 days", () => {
    const snapshot = mergeAssetSnapshots({ assets: [asset("deleted"), asset("edited", "2030-01-31T12:00:00Z"), asset("expired", "2029-01-01T12:00:00Z")] }, {
        tombstones: [{ id: "deleted", deletedAt: "2030-01-30T12:00:00Z" }, { id: "edited", deletedAt: "2030-01-29T12:00:00Z" }, { id: "expired", deletedAt: "2029-01-02T12:00:00Z" }],
    }, now);
    assert.deepEqual(snapshot.assets.map(item => item.id), ["edited"]);
    assert.deepEqual(snapshot.tombstones.map(item => item.id), ["deleted", "edited"]);
    const merged = mergeAssetSnapshots({ assets: [], tombstones: [{ id: "deleted", deletedAt: "2030-01-31T12:00:00Z" }] }, snapshot, now);
    assert.equal(merged.tombstones[0].deletedAt, "2030-01-31T12:00:00Z");
    assert.deepEqual(mergeAssetSnapshots({ assets: null, tombstones: null }, {}, now), { assets: [], tombstones: [] });
});
