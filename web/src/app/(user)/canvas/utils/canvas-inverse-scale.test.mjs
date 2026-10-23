import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const canvas = readFileSync(new URL("../components/infinite-canvas.tsx", import.meta.url), "utf8");
const promptPanel = readFileSync(new URL("../components/canvas-node-prompt-panel.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");

function inverseScale(viewportScale) {
    return 1 / viewportScale;
}

test("prompt panel and double-click menu cancel canvas zoom without redefining the shared variable", () => {
    const promptPanelStyle = promptPanel.match(/<div\s+data-canvas-no-zoom[\s\S]*?style=\{\{([\s\S]*?)\}\}/)?.[1] || "";
    assert.ok(
        /transform:\s*"scale\(var\(--canvas-inverse-scale\)\)"/.test(promptPanelStyle),
        "prompt panel needs an inverse-scale transform",
    );
    assert.ok(
        /transformOrigin:\s*"top center"/.test(promptPanelStyle),
        "prompt panel must keep its top-center anchor",
    );

    const createMenu = page.match(/function NodeCreateMenu[\s\S]*?\n\}\n\nfunction InfiniteCanvasPage/)?.[0] || "";
    const createMenuStyle = createMenu.match(/data-canvas-no-zoom[\s\S]*?style=\{\{([\s\S]*?)\}\}/)?.[1] || "";
    assert.ok(
        /transform:\s*"scale\(calc\(var\(--canvas-inverse-scale\) \* 0\.9\)\)"/.test(createMenuStyle),
        "double-click create menu needs inverse scale with its existing 0.9 visual size",
    );
    assert.ok(
        /transformOrigin:\s*"top left"/.test(createMenuStyle),
        "double-click create menu must keep its top-left anchor",
    );

    const definitions = [...`${canvas}\n${promptPanel}\n${page}`.matchAll(/--canvas-inverse-scale"?:/g)];
    assert.equal(definitions.length, 1, "the inverse-scale variable must be defined only on the canvas viewport");
});

test("100% canvas zoom leaves both overlays at their existing visual scale", () => {
    assert.equal(inverseScale(1), 1);
    assert.equal(inverseScale(1) * 0.9, 0.9);
});
