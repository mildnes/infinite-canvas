import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const node = readFileSync(new URL("../components/canvas-node.tsx", import.meta.url), "utf8");
const toolbar = readFileSync(new URL("../components/canvas-node-hover-toolbar.tsx", import.meta.url), "utf8");
const assistant = readFileSync(new URL("../components/canvas-assistant-panel.tsx", import.meta.url), "utf8");

test("文本节点编辑工具接入按节点 nonce，并保持光标末尾逻辑", () => {
    assert.match(page, /editRequestNonces/);
    assert.match(page, /editRequestNonce=\{editRequestNonces\[node\.id\] \?\? 0\}/);
    assert.match(page, /onEditText=\{requestTextEdit\}/);
    assert.match(page, /setEditRequestNonces\(\(current\) => \(\{ \.\.\.current, \[node\.id\]: \(current\[node\.id\] \|\| 0\) \+ 1 \}\)\)/);
    assert.match(node, /if \(!editRequestNonce \|\| data\.type !== CanvasNodeType\.Text\) return/);
    assert.match(node, /setSelectionRange\(textarea\.value\.length, textarea\.value\.length\)/);
});

test("编辑文字按钮仅文本节点显示", () => {
    assert.match(toolbar, /\(isText \? \[\{ id: "editText"/);
    assert.match(toolbar, /onClick: \(\) => onEditText\(node\)/);
});

test("助手面板取消已选节点接回画布选择集合", () => {
    assert.match(page, /onSelectNodeIds=\{setSelectedNodeIds\}/);
    const assistantCall = page.match(/<CanvasAssistantPanel[\s\S]*?\/>/)?.[0] || "";
    assert.doesNotMatch(assistantCall, /\bcanvasId=/);
    assert.match(assistant, /if \(selectedNodeIds\.has\(id\)\) onSelectNodeIds\(new Set\(Array\.from\(selectedNodeIds\)\.filter\(\(nodeId\) => nodeId !== id\)\)\)/);
});

test("编辑请求 nonce 每次点击递增，其他节点保持 0", () => {
    const next = (state, id) => ({ ...state, [id]: (state[id] || 0) + 1 });
    let state = {};
    state = next(state, "text-a");
    state = next(state, "text-a");
    assert.deepEqual(state, { "text-a": 2 });
    assert.equal(state["text-b"] || 0, 0);
});
