import assert from "node:assert/strict";
import test from "node:test";

import { resolveImageQuality } from "../../../../lib/image-quality.ts";
import { normalizeImageQualityCapabilities } from "./image-quality-capabilities.ts";

test("归一化允许质量值并丢弃失效映射和默认值", () => {
    const result = normalizeImageQualityCapabilities({
        image: {
            values: [" high ", "high", "  ", "auto"],
            map: { " MAX ": " high ", low: "not-allowed", medium: " " },
            defaultValue: "not-allowed",
        },
    }, ["image"]);

    assert.deepEqual(result, {
        image: { values: ["high", "auto"], map: { max: "high" } },
    });
});

test("移除允许值后清理无效引用，不改其他模型或输入对象", () => {
    const original = {
        image: {
            values: ["low", "high"],
            map: { max: "high", xhigh: "low" },
            defaultValue: "low",
        },
        other: { values: ["native"], map: { max: "native" }, defaultValue: "native" },
    };
    const edited = {
        ...original,
        image: { ...original.image, values: [" high "] },
    };

    const result = normalizeImageQualityCapabilities(edited, ["image", "other"]);

    assert.deepEqual(result, {
        image: { values: ["high"], map: { max: "high" } },
        other: original.other,
    });
    assert.deepEqual(original.image, {
        values: ["low", "high"],
        map: { max: "high", xhigh: "low" },
        defaultValue: "low",
    });
});

test("保留空声明与未声明之间的解析差异，并丢弃非当前渠道模型", () => {
    const declaredEmpty = normalizeImageQualityCapabilities({
        image: { values: [], map: { max: "stale" }, defaultValue: "stale" },
        removed: { values: ["high"] },
    }, ["image"]);

    assert.deepEqual(declaredEmpty, { image: { values: [] } });
    assert.deepEqual(resolveImageQuality("max", declaredEmpty.image), { quality: undefined, fellBack: true });
    assert.equal(normalizeImageQualityCapabilities(undefined, ["image"]), undefined);
    assert.deepEqual(resolveImageQuality("max"), { quality: "max", fellBack: false });
});

test("支持 xhigh 和 max 的显式映射，并在缺失映射时回退到默认值", () => {
    const capabilities = normalizeImageQualityCapabilities({
        image: {
            values: ["ultra", "premium", "standard"],
            map: { xhigh: "ultra", max: "premium" },
            defaultValue: "standard",
        },
    }, ["image"]);

    assert.deepEqual(resolveImageQuality("xhigh", capabilities.image), { quality: "ultra", fellBack: true });
    assert.deepEqual(resolveImageQuality("max", capabilities.image), { quality: "premium", fellBack: true });
    assert.deepEqual(resolveImageQuality("low", capabilities.image), { quality: "standard", fellBack: true });
});
