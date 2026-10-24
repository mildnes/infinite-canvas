import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canvasPersistSignature } from "../app/(user)/canvas/utils/canvas-persist-signature.ts";

const page = readFileSync(new URL("../app/(user)/canvas/[id]/canvas-client-page.tsx", import.meta.url), "utf8");

const node = (overrides = {}) => ({
    id: "n1", type: "image", title: "节点", position: { x: 10, y: 20 }, width: 320, height: 200,
    metadata: { content: "server:abc", status: "loading", progress: 0, imageTaskId: "t1" },
    ...overrides,
});
const state = (overrides = {}) => ({
    nodes: [node()], connections: [{ id: "c1", fromNodeId: "n1", toNodeId: "n2" }],
    chatSessions: [{ id: "s1", messages: [{ role: "user", content: "hi" }] }],
    activeChatId: "s1", agentConfig: { model: "m" }, backgroundMode: "lines",
    showImageInfo: false, showConnections: true, snapToGrid: false, ...overrides,
});

test("progress ticks alone do not change the persistence signature", () => {
    const before = canvasPersistSignature(state());
    const after = canvasPersistSignature({ ...state(), nodes: [node({ metadata: { ...node().metadata, progress: 87, elapsedMs: 54321 } })] });
    assert.equal(after, before, "poll-driven progress must not look like a persistable change");
});

test("task status transitions do change the signature", () => {
    const before = canvasPersistSignature(state());
    const after = canvasPersistSignature({ nodes: [node({ metadata: { ...node().metadata, status: "success" } })] });
    assert.notEqual(after, before, "status transitions must still be saved");
});

test("content, geometry and connections are part of the signature", () => {
    const base = canvasPersistSignature(state());
    assert.notEqual(canvasPersistSignature({ nodes: [node({ metadata: { ...node().metadata, content: "server:xyz" } })] }), base, "content");
    assert.notEqual(canvasPersistSignature({ nodes: [node({ position: { x: 11, y: 20 } })] }), base, "position");
    assert.notEqual(canvasPersistSignature({ nodes: [node({ width: 321 })] }), base, "width");
    assert.notEqual(canvasPersistSignature({ connections: [] }), base, "connections");
    assert.notEqual(canvasPersistSignature({ snapToGrid: true }), base, "display flags");
});

test("large inline payloads are compared without keeping the whole string", () => {
    const head = "data:image/png;base64," + "A".repeat(4096);
    const first = canvasPersistSignature({ nodes: [node({ metadata: { ...node().metadata, content: head + "TAIL-A" } })] });
    const second = canvasPersistSignature({ nodes: [node({ metadata: { ...node().metadata, content: head + "TAIL-B" } })] });
    assert.notEqual(first, second, "a different image payload must still be detected");
});

test("chat activity is part of the signature", () => {
    const base = canvasPersistSignature(state());
    const more = canvasPersistSignature({ chatSessions: [{ id: "s1", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] }] });
    assert.notEqual(more, base, "agent history must be persisted");
});

test("the canvas page gates its autosave on the persistence signature", () => {
    assert.ok(/const signature = canvasPersistSignature\(/.test(page), "the autosave effect must compute a persistence signature");
    assert.ok(/if \(signature === lastPersistSignatureRef\.current\) return;/.test(page), "an unchanged signature must not trigger a save");
    assert.ok(/lastPersistSignatureRef\.current = canvasPersistSignature\(/.test(page), "ad-hoc persists must refresh the signature too");
});

test("the canvas page no longer subscribes to the whole project object", () => {
    assert.ok(!/state\.projects\.find\(\(project\) => project\.id === projectId\)\)/.test(page), "subscribing to the project object re-renders the page on every save response");
    assert.ok(/state\.projects\.find\(\(project\) => project\.id === projectId\)\?\.title/.test(page), "only the title is consumed, so only the title should be subscribed");
});

test("payloads that differ only in the middle are not treated as identical", () => {
    const head = "data:image/png;base64," + "A".repeat(512);
    const tail = "Z".repeat(512);
    const first = head + "MIDDLE-ONE" + tail;
    const second = head + "MIDDLE-TWO" + tail;
    assert.equal(first.length, second.length, "the fixture must keep the lengths identical");
    const a = canvasPersistSignature({ nodes: [node({ metadata: { ...node().metadata, content: first } })] });
    const b = canvasPersistSignature({ nodes: [node({ metadata: { ...node().metadata, content: second } })] });
    assert.notEqual(a, b, "a middle-only change must still change the signature");
});
