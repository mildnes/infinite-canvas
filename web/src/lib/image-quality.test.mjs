import assert from "node:assert/strict";
import test from "node:test";

import { IMAGE_QUALITY_OPTIONS, imageQualityLabel, normalizeImageQuality } from "./image-quality.ts";

test("图片质量六档顺序和值保持一致", () => {
    assert.deepEqual(IMAGE_QUALITY_OPTIONS.map(({ value, label }) => [value, label]), [
        ["low", "低"],
        ["medium", "中"],
        ["high", "高"],
        ["xhigh", "极高"],
        ["max", "最高"],
        ["auto", "自动"],
    ]);
});

test("极高和最高不会被归一化为自动", () => {
    assert.equal(normalizeImageQuality("xhigh"), "xhigh");
    assert.equal(normalizeImageQuality("max"), "max");
    assert.equal(normalizeImageQuality("4k"), "high");
    assert.equal(normalizeImageQuality("unknown"), "auto");
    assert.equal(imageQualityLabel("max"), "最高");
});
