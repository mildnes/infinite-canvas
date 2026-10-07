import assert from "node:assert/strict";
import test from "node:test";
import { previewDimensions, prepareImagePreview } from "./image-preview.ts";

test("preview bounds preserve ratio and never upscale small originals", () => {
    assert.deepEqual(previewDimensions(5504, 3072), { width: 1024, height: 572 });
    assert.deepEqual(previewDimensions(100, 200), { width: 100, height: 200 });
    assert.deepEqual(previewDimensions(1000, 8000), { width: 128, height: 1024 });
});

test("audio/video and unavailable browser preview are best effort without downloading", async () => {
    assert.equal(await prepareImagePreview(new Blob(["audio"], { type: "audio/wav" })), null);
    assert.equal(await prepareImagePreview(new Blob(["png"], { type: "image/png" })), null);
});

test("opaque decoded PNG pixels retain JPEG q80, deduplicated without mutating original", async (t) => {
    const previous = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
    t.after(() => Object.assign(globalThis, previous));
    const draws = [];
    let decoded = 0, closed = 0;
    globalThis.document = {};
    let bitmapOptions;
    globalThis.createImageBitmap = async (_blob, options) => { decoded++; bitmapOptions = options; return { width: 1024, height: 572, close() { closed++; } }; };
    globalThis.OffscreenCanvas = class {
        constructor(width, height) { this.width = width; this.height = height; }
        getContext() { return { fillStyle: "", fillRect(...args) { draws.push(["white", this.fillStyle, this.globalCompositeOperation, ...args]); }, drawImage(...args) { draws.push(["image", ...args.slice(1)]); }, getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }) }; }
        async convertToBlob(options) { draws.push(["encoded", options, this.width, this.height]); return new Blob(["preview"], { type: options.type }); }
    };
    const original = new Blob(["original-PNG"], { type: "image/png" });
    const [a, b] = await Promise.all([prepareImagePreview(original, { width: 5504, height: 3072 }), prepareImagePreview(original, { width: 5504, height: 3072 })]);
    assert.equal(a, b);
    assert.equal(a.type, "image/jpeg");
    assert.equal(decoded, 1);
    assert.equal(closed, 1);
    assert.deepEqual(bitmapOptions, { resizeWidth: 1024, resizeHeight: 572, resizeQuality: "high" });
    assert.equal(await original.text(), "original-PNG");
    assert.deepEqual(draws[0], ["image", 0, 0, 1024, 572]);
    assert.deepEqual(draws.find(row => row[0] === "white"), ["white", "#fff", "destination-over", 0, 0, 1024, 572]);
    assert.deepEqual(draws.at(-1), ["encoded", { type: "image/jpeg", quality: 0.8 }, 1024, 572]);
});

test("alpha <250 selects PNG after a <=64 probe, regardless of PNG/WebP/GIF MIME", async (t) => {
    const previous = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.document = {};
    globalThis.createImageBitmap = async () => ({ width: 1024, height: 576, close() {} });
    for (const mime of ["image/png", "image/webp", "image/gif"]) {
        for (const alpha of [0, 249, 250, 255]) {
            const probes = [], fills = [];
            globalThis.OffscreenCanvas = class {
                constructor(width, height) { this.width = width; this.height = height; }
                getContext() { return { drawImage() {}, fillRect: () => fills.push(true), getImageData: (x, y, width, height) => {
                    probes.push([width, height]);
                    return { data: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, alpha]) };
                } }; }
                async convertToBlob({ type }) { return new Blob(["preview"], { type }); }
            };
            const original = new Blob(["original"], { type: mime });
            const preview = await prepareImagePreview(original);
            assert.equal(preview.type, alpha < 250 ? "image/png" : "image/jpeg");
            assert.deepEqual(probes, [[64, 36]]);
            assert.equal(fills.length, alpha < 250 ? 0 : 1);
            assert.equal(await original.text(), "original");
        }
    }
});

test("HTML canvas fallback also preserves transparent PNG without a white fill", async (t) => {
    const previous = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.createImageBitmap = async () => ({ width: 16, height: 8, close() {} });
    globalThis.OffscreenCanvas = undefined;
    const encodes = [], probes = [];
    globalThis.document = { createElement: () => ({ getContext: () => ({
        drawImage() {}, fillRect() { assert.fail("transparent preview was flattened"); },
        getImageData: (x, y, w, h) => { probes.push([w, h]); return { data: new Uint8ClampedArray([255, 255, 255, 0]) }; },
    }), toBlob(callback, type, quality) { encodes.push([type, quality]); callback(new Blob(["preview"], { type })); } }) };
    assert.equal((await prepareImagePreview(new Blob(["png"], { type: "image/png" }))).type, "image/png");
    assert.deepEqual(encodes, [["image/png", 0.8]]);
    assert.deepEqual(probes, [[16, 8]]);
});

test("giant decode failure or invalid dimensions skip silently without a full DOM decode", async (t) => {
    const previous = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap, Image: globalThis.Image };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.document = {};
    let decodes = 0, domDecodes = 0;
    globalThis.Image = class { constructor() { domDecodes++; } };
    globalThis.createImageBitmap = async (_blob, options) => {
        decodes++;
        assert.deepEqual(options, { resizeWidth: 916, resizeHeight: 1024, resizeQuality: "high" });
        throw new Error("decoder memory limit");
    };
    const blob = new Blob(["giant"], { type: "image/png" });
    const size = { width: 20080, height: 22450 };
    assert.equal(await prepareImagePreview(blob, size), null);
    assert.equal(await prepareImagePreview(blob, size), null);
    assert.equal(decodes, 1);
    assert.equal(domDecodes, 0);
    for (const invalid of [{ width: 0, height: 10 }, { width: NaN, height: 10 }, { width: 10, height: Infinity }]) {
        assert.equal(await prepareImagePreview(new Blob(["invalid"], { type: "image/png" }), invalid), null);
    }
    globalThis.createImageBitmap = undefined;
    assert.equal(await prepareImagePreview(new Blob(["unsupported"], { type: "image/png" }), size), null);
    assert.equal(domDecodes, 0);
});
