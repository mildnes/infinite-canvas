import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/(user)/canvas/components/canvas-node.tsx", import.meta.url), "utf8");

test("resize drag listeners survive the node re-rendering mid-drag", () => {
    // The drag listeners are attached in handleResizeMouseDown. If an effect that depends on the
    // handlers (they close over `data`, which changes on the first applied resize) removes them,
    // the drag silently stops after its first frame.
    assert.ok(
        !/\}, \[handleResizeMove, handleResizeUp\]\);/.test(source),
        "the cleanup effect must not depend on the drag handlers",
    );
    assert.ok(
        /attachedResizeRef\.current = \{ move: handleResizeMove, up: handleResizeUp \};/.test(source),
        "the attached handlers must be recorded so unmount can remove exactly those",
    );
    assert.ok(
        /const attached = attachedResizeRef\.current;/.test(source),
        "unmount cleanup must use the recorded handlers",
    );
    const cleanup = source.match(/useEffect\(\(\) => \{\s*return \(\) => \{([\s\S]*?)\};\s*\}, \[\]\);/);
    assert.ok(cleanup, "the resize cleanup effect must run only on unmount (empty dependency list)");
    assert.ok(/window\.removeEventListener\("mousemove", attached\.move\)/.test(cleanup[1]), "cleanup must remove the recorded mousemove handler");
});

test("a resize keeps the scale captured at mousedown", () => {
    assert.ok(/scale: scaleRef\.current,/.test(source), "resize must snapshot the canvas scale when the drag starts");
    assert.ok(/\/ resizeRef\.current\.scale/.test(source), "resize math must divide by the snapshotted scale");
});
