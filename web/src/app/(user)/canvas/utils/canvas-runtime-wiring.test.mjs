import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const node = readFileSync(new URL("../components/canvas-node.tsx", import.meta.url), "utf8");
const toolbar = readFileSync(new URL("../components/canvas-node-hover-toolbar.tsx", import.meta.url), "utf8");
const assistant = readFileSync(new URL("../components/canvas-assistant-panel.tsx", import.meta.url), "utf8");
const promptPanel = readFileSync(new URL("../components/canvas-node-prompt-panel.tsx", import.meta.url), "utf8");
const configPanel = readFileSync(new URL("../components/canvas-config-node-panel.tsx", import.meta.url), "utf8");

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
    assert.match(assistant, /if \(reason === "user"\) deselectNodeIds\(removedSelectedIds\)/);
    assert.match(assistant, /onRemoveReference=\{\(id\) => \{[\s\S]*?removeComposerReference\(id\)/);
});

test("编辑请求 nonce 每次点击递增，其他节点保持 0", () => {
    const next = (state, id) => ({ ...state, [id]: (state[id] || 0) + 1 });
    let state = {};
    state = next(state, "text-a");
    state = next(state, "text-a");
    assert.deepEqual(state, { "text-a": 2 });
    assert.equal(state["text-b"] || 0, 0);
});

test("画板生成默认配置继承 Agent 设置，节点显式参数仍由节点配置覆盖", () => {
    assert.match(page, /applyCanvasAgentGenerationDefaults/);
    assert.match(page, /const canvasGenerationDefaults = useMemo/);
    assert.match(page, /const baseGenerationConfig = mode === "image" \|\| mode === "video" \? canvasGenerationDefaults : effectiveConfig/);
    assert.match(page, /size: node\.metadata\?\.size \|\| baseGenerationConfig\.size \|\| "auto"/);
    assert.match(page, /generationDefaults=\{canvasGenerationDefaults\}/);
    assert.match(promptPanel, /generationDefaults\?: AiConfig/);
    assert.match(promptPanel, /buildNodeConfig\(generationDefaults \|\| globalConfig, node, mode\)/);
    assert.match(configPanel, /generationDefaults\?: AiConfig/);
    assert.match(configPanel, /buildNodeConfig\(generationDefaults \|\| globalConfig, node, mode\)/);
    assert.match(configPanel, /modePatch\(generationDefaults \|\| globalConfig/);
});
