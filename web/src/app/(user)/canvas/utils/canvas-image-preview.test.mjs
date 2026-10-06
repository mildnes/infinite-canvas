import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { previewSrcFor, fallbackCanvasPreview, loadOriginalImage } from "./canvas-image-preview.ts";

test("canvas display maps stable references without changing original URLs", () => {
    assert.equal(previewSrcFor("/api/files/abc-123/content"), "/api/files/abc-123/preview");
    assert.equal(previewSrcFor("https://example.com/api/files/abc_123/content"), "https://example.com/api/files/abc_123/preview");
    assert.equal(previewSrcFor("blob:local", "server:abc-123"), "/api/files/abc-123/preview");
    for (const src of ["data:image/png;base64,abc", "blob:local", "https://image.example/a.png", "/api/proxy-image?url=https://example.com/a.png"]) {
        assert.equal(previewSrcFor(src), src);
    }
    assert.equal(previewSrcFor("blob:local", "server:webdav:path"), "blob:local");
    assert.equal(previewSrcFor("/api/files/a%2Fb/content"), "/api/files/a%2Fb/content");
});

test("missing preview falls back once to original, without an error loop", () => {
    const { document } = new JSDOM("<img>").window;
    const image = document.querySelector("img");
    image.src = "/api/files/abc/preview";
    fallbackCanvasPreview(image, "/api/files/abc/content");
    assert.equal(image.getAttribute("src"), "/api/files/abc/content");
    fallbackCanvasPreview(image, "/api/files/abc/content");
    assert.equal(image.getAttribute("src"), "/api/files/abc/content");
});

test("two-stage viewer loads original, reports failure and discards late callbacks", () => {
    const images = [];
    const create = () => { const image = {}; images.push(image); return image; };
    const results = [];
    const cancel = loadOriginalImage("/api/files/a/content", value => results.push(value), create);
    const lateLoad = images[0].onload;
    cancel();
    lateLoad();
    assert.deepEqual(results, []);
    loadOriginalImage("/api/files/b/content", value => results.push(value), create);
    images[1].onerror();
    assert.deepEqual(results, ["failed"]);
    loadOriginalImage("/api/files/b/content", value => results.push(value), create);
    images[2].onload();
    assert.deepEqual(results, ["failed", "ready"]);
    assert.equal(images[2].src, "/api/files/b/content");
});
