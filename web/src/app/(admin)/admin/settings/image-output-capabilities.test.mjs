import assert from "node:assert/strict";
import test from "node:test";

import { normalizeImageOutputCapabilities } from "./image-output-capabilities.ts";

test("normalizes formats and clears a default that is not in the allowed set", () => {
    const result = normalizeImageOutputCapabilities({
        custom: { formats: ["png-transparent", "jpeg", "png-transparent", "gif"], defaultFormat: "gif" },
        removed: { formats: ["jpeg"], defaultFormat: "jpeg" },
    }, ["custom"]);

    assert.deepEqual(result, { custom: { formats: ["png-transparent", "jpeg"] } });
});

test("preserves an explicit empty formats declaration through JSON save and reload", () => {
    const saved = normalizeImageOutputCapabilities({
        custom: { formats: [], defaultFormat: "jpeg" },
        other: { formats: ["jpeg"], defaultFormat: "jpeg" },
    }, ["custom", "other"]);
    const reloaded = normalizeImageOutputCapabilities(JSON.parse(JSON.stringify(saved)), ["custom", "other"]);

    assert.deepEqual(saved, { custom: { formats: [] }, other: { formats: ["jpeg"], defaultFormat: "jpeg" } });
    assert.deepEqual(reloaded, saved);
    assert.equal(normalizeImageOutputCapabilities(undefined, ["custom"]), undefined);
});

test("does not mutate hand-written JSON declarations", () => {
    const original = { custom: { formats: ["jpeg", "jpeg"], defaultFormat: "jpeg" } };
    normalizeImageOutputCapabilities(original, ["custom"]);

    assert.deepEqual(original, { custom: { formats: ["jpeg", "jpeg"], defaultFormat: "jpeg" } });
});
