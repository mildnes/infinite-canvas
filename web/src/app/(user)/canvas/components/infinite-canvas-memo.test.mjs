import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const node = readFileSync(new URL("../components/canvas-node.tsx", import.meta.url), "utf8");

test("canvas page removes continuous scale props and stabilizes node callbacks", () => {
    const nodeStart = page.indexOf("<CanvasNode\n");
    const nodeCall = nodeStart >= 0 ? page.slice(nodeStart).match(/<CanvasNode[\s\S]*?\/>/)?.[0] || "" : "";
    assert.ok(!/\bscale=\{viewport\.k\}/.test(nodeCall), "CanvasNode must not receive continuous viewport scale");
    assert.ok(/\bscaleRef=\{scaleRef\}/.test(nodeCall), "CanvasNode should consume the shared scale ref");
    assert.ok(/onHoverStart=\{handleNodeHoverStart\}/.test(nodeCall), "hover start callback must be stable");
    assert.ok(/onHoverEnd=\{handleNodeHoverEnd\}/.test(nodeCall), "hover end callback must be stable");
    assert.ok(/onRetry=\{handleNodeRetry\}/.test(nodeCall), "retry callback must be stable");
    assert.ok(/onViewImage=\{handleNodeViewImage\}/.test(nodeCall), "view image callback must be stable");
    assert.ok(/renderPanel=\{renderNodePanel\}/.test(nodeCall), "panel renderer callback must be stable");
    assert.ok(/const renderNodePanel = useCallback/.test(page), "panel renderer callback must be stable");
    assert.ok(/scaleRef:/.test(node), "CanvasNode must expose scaleRef prop");
    assert.ok(!/const dx = \(event\.clientX - resizeRef\.current\.startX\) \/ scale/.test(node), "resize math must not close over a prop scale");
    assert.ok(/resizeRef\.current\.scale/.test(node), "resize math must read the shared scale ref");
});

test("canvas page uses stable empty references for node props", () => {
    assert.ok(/const EMPTY_REFERENCES: CanvasNodeResourceReference\[\] = \[\];/.test(page), "page must define a stable empty reference array");
    assert.ok(/mentionReferencesByNodeId\.get\(node\.id\) \|\| EMPTY_REFERENCES/.test(page), "node mentions must use the stable empty reference array");
});
