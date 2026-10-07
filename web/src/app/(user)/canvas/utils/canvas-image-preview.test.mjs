import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { previewSrcFor, fallbackCanvasPreview, loadOriginalImage, previewContentHit } from "./canvas-image-preview.ts";

test("object-contain hit detection keeps content and edges, releases letterbox on all sides", () => {
    const rect = { left: 120, top: 80, width: 1000, height: 800 };
    for (const [width, height] of [[1200, 300], [1024, 256]]) {
        for (const [x, y] of [[620, 480], [121, 356], [1119, 604], [120, 355], [1120, 605]]) {
            assert.equal(previewContentHit(rect, width, height, x, y), true, `content ${x},${y}`);
        }
        for (const [x, y] of [[620, 354], [620, 606]]) {
            assert.equal(previewContentHit(rect, width, height, x, y), false, `top/bottom ${x},${y}`);
        }
    }
    for (const [x, y] of [[519, 480], [721, 480]]) assert.equal(previewContentHit(rect, 300, 1200, x, y), false, `left/right ${x},${y}`);
    for (const [x, y] of [[521, 81], [719, 879], [520, 80], [720, 880]]) assert.equal(previewContentHit(rect, 300, 1200, x, y), true, `portrait edge ${x},${y}`);
    assert.equal(previewContentHit({ left: 150, top: 200, width: 500, height: 400 }, 1200, 300, 400, 330, 0.5), false, "transformed rectangle below 1x");
});

test("object-contain hit detection conservatively keeps unloaded images and zoom interactions", () => {
    const rect = { left: 120, top: 80, width: 1000, height: 800 };
    for (const [width, height] of [[0, 0], [0, 300], [1200, 0]]) assert.equal(previewContentHit(rect, width, height, 620, 100), true);
    for (const zoom of [1.01, 2, 8]) assert.equal(previewContentHit(rect, 1200, 300, 620, 100, zoom), true);
    assert.equal(previewContentHit({ ...rect, width: 0 }, 1200, 300, 620, 100), true);
});

test("canvas display maps stable references without changing original URLs", () => {
    assert.equal(previewSrcFor("/api/files/abc-123/content"), "/api/files/abc-123/preview?v=2");
    assert.equal(previewSrcFor("https://example.com/api/files/abc_123/content"), "https://example.com/api/files/abc_123/preview?v=2");
    assert.equal(previewSrcFor("blob:local", "server:abc-123"), "/api/files/abc-123/preview?v=2");
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
