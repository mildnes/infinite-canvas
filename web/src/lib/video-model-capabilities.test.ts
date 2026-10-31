import assert from "node:assert/strict";
import test from "node:test";

import { isAgnesVideoV25Model } from "./video-model-capabilities";

test("Agnes Video 2.5 detection accepts provider suffixes and dotted separators", () => {
    for (const model of [
        "agnes-video-2-5",
        "agnes-video-2-5-flash",
        "Agnes.Video.2.5-flash",
    ]) {
        assert.equal(isAgnesVideoV25Model(model), true, model);
    }
    for (const model of ["agnes-video-2-4", "agnes-video", "other-video-2-5"]) {
        assert.equal(isAgnesVideoV25Model(model), false, model);
    }
});
