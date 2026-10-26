import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const initialDom = installDom();
const { CanvasAssistantPanel } = await import("../app/(user)/canvas/components/canvas-assistant-panel.tsx");
const { CanvasPromptChipInput } = await import("../app/(user)/canvas/components/canvas-prompt-chip-input.tsx");

const baseline = process.env.REFERENCE_SYNC_BASELINE?.trim();
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function installDom() {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
    const requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
    const cancelAnimationFrame = (id) => clearTimeout(id);
    const matchMedia = () => ({
        matches: false,
        media: "",
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
    });
    const globals = {
        window: dom.window,
        document: dom.window.document,
        localStorage: dom.window.localStorage,
        sessionStorage: dom.window.sessionStorage,
        IS_REACT_ACT_ENVIRONMENT: true,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame,
        cancelAnimationFrame,
        matchMedia,
        ResizeObserver: class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
        IntersectionObserver: class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    };
    for (const key of [
        "Node",
        "Element",
        "HTMLElement",
        "HTMLBRElement",
        "SVGElement",
        "DocumentFragment",
        "MutationObserver",
        "Event",
        "MouseEvent",
        "KeyboardEvent",
        "ShadowRoot",
        "getSelection",
    ]) {
        globals[key] = dom.window[key];
    }
    globals.PointerEvent = dom.window.PointerEvent || dom.window.MouseEvent;
    Object.assign(globalThis, globals);
    dom.window.requestAnimationFrame = requestAnimationFrame;
    dom.window.cancelAnimationFrame = cancelAnimationFrame;
    dom.window.matchMedia = matchMedia;
    return dom;
}

function sourceAt(path) {
    if (baseline) {
        return execFileSync("git", ["show", `${baseline}:${path}`], {
            cwd: repositoryRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
    }
    return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

function reference(id, label) {
    return {
        id,
        nodeId: id,
        kind: "text",
        label,
        title: `节点 ${id}`,
        text: `内容 ${id}`,
        active: true,
    };
}

function textNode(id) {
    return {
        id,
        type: "text",
        title: `节点 ${id}`,
        position: { x: 0, y: 0 },
        width: 120,
        height: 80,
        metadata: { content: `内容 ${id}` },
    };
}

function createTestRoot() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    return {
        root,
        async cleanup() {
            await act(async () => root.unmount());
            container.remove();
        },
    };
}

async function flushReactTimers() {
    await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 5));
    });
}

function jsxAttribute(ast, name) {
    let expression = null;
    const visit = (node) => {
        if (ts.isJsxAttribute(node) && node.name.getText(ast) === name && node.initializer && ts.isJsxExpression(node.initializer)) {
            expression = node.initializer.expression;
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    return expression;
}

function helperDefinitions(ast) {
    const definitions = new Map();
    const visit = (node) => {
        if (
            ts.isVariableDeclaration(node)
            && ts.isIdentifier(node.name)
            && node.initializer
            && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ) {
            definitions.set(node.name.text, node.initializer.body);
        } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
            definitions.set(node.name.text, node.body);
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    return definitions;
}

function reachesSelectionRemoval(expression, definitions, seen = new Set()) {
    if (!expression) return false;
    let found = false;
    const visit = (node) => {
        if (found) return;
        if (ts.isIdentifier(node)) {
            if (node.text === "onSelectNodeIds") {
                found = true;
                return;
            }
            if (!seen.has(node.text) && definitions.has(node.text)) {
                const nextSeen = new Set(seen).add(node.text);
                if (reachesSelectionRemoval(definitions.get(node.text), definitions, nextSeen)) found = true;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(expression);
    return found;
}

test("自动清理 stale chip 标记为 prune，和用户主动删除严格区分", async () => {
    const inputSource = sourceAt("web/src/app/(user)/canvas/components/canvas-prompt-chip-input.tsx");
    assert.ok(
        /onReferenceIdsChangeRef\.current\?\.\(referenceIdsFromEditor\(editor\), "prune"\)/.test(inputSource),
        "自动 prune 必须显式传 reason=prune；不能复用用户删除回调语义",
    );
    assert.ok(
        /onReferenceIdsChangeRef\.current\?\.\(referenceIdsFromEditor\(editorRef\.current\), "user"\)/.test(inputSource),
        "用户输入/删除必须显式传 reason=user",
    );

    const { root, cleanup } = createTestRoot();
    const referenceChanges = [];
    const promptChanges = [];
    const render = async (activeReferenceIds) => {
        await act(async () => {
            root.render(
                React.createElement(CanvasPromptChipInput, {
                    value: "图片1 图片2",
                    references: [reference("a", "图片1"), reference("b", "图片2")],
                    activeReferenceIds,
                    onChange: (next) => promptChanges.push(next),
                    onReferenceIdsChange: (ids, reason) => referenceChanges.push({ ids, reason }),
                    placeholder: "测试引用",
                }),
            );
        });
    };

    try {
        await render(["a", "b"]);
        const editor = document.querySelector('[role="textbox"]');
        assert.ok(editor, "编辑区必须渲染");
        assert.deepEqual(
            [...editor.querySelectorAll("[data-ref-node-id]")].map((chip) => chip.dataset.refNodeId),
            ["a", "b"],
        );

        await render(["b"]);

        assert.deepEqual(
            [...editor.querySelectorAll("[data-ref-node-id]")].map((chip) => chip.dataset.refNodeId),
            ["b"],
            "上层已删除的引用 chip 不得继续留在编辑区",
        );
        assert.equal(promptChanges.at(-1)?.includes("图片1") ?? false, false, "prompt 必须同步移除 stale chip");
        assert.deepEqual(referenceChanges.at(-1), { ids: ["b"], reason: "prune" });
    } finally {
        await cleanup();
    }
});

test("连续 20 次框选级选中变化不反向写 selectedNodeIds，Agent 面板保持挂载", async () => {
    const panelSource = sourceAt("web/src/app/(user)/canvas/components/canvas-assistant-panel.tsx");
    assert.ok(
        /reason:\s*"prune"\s*\|\s*"user"\s*=\s*"user"/.test(panelSource),
        "面板必须接收删除来源，默认来源只能是主动用户删除",
    );
    assert.ok(
        /if\s*\(reason\s*===\s*"user"\)\s*deselectNodeIds\(removedSelectedIds\)/.test(panelSource),
        "只有用户主动删除引用时才能反向取消画布选中",
    );

    const { root, cleanup } = createTestRoot();
    const nodes = Array.from({ length: 20 }, (_, index) => textNode(`n${index}`));
    const selectionWrites = [];
    let updateSelection;

    function Harness() {
        const [selectedNodeIds, setSelectedNodeIds] = useState(new Set());
        updateSelection = setSelectedNodeIds;
        return React.createElement(CanvasAssistantPanel, {
            nodes,
            selectedNodeIds,
            referenceNodeClick: { nodeId: null, version: 0 },
            sessions: [],
            activeSessionId: null,
            agentConfig: {},
            width: 420,
            onWidthChange() {},
            onFocusNode() {},
            onSelectNodeIds: (ids) => {
                selectionWrites.push([...ids]);
                setSelectedNodeIds(ids);
            },
            onSessionsChange() {},
            onAgentConfigChange() {},
            onPasteImage() {},
            onOpenUpload() {},
            onOpenAssets() {},
            getAgentContext: () => ({}),
            onExecuteAction: async () => ({ ok: true }),
            onCollapseStart() {},
            onCollapse() {},
        });
    }

    try {
        await act(async () => root.render(React.createElement(Harness)));
        for (let index = 0; index < 20; index += 1) {
            await act(async () => {
                updateSelection(new Set(nodes.slice(0, index + 1).map((node) => node.id)));
                await Promise.resolve();
            });
            await flushReactTimers();
        }

        assert.deepEqual(selectionWrites, [], "框选期间只能由画布更新 Agent，Agent 不得反向写选择集合");
        assert.ok(document.querySelector('[role="textbox"]'), "框选结束时 Agent 面板必须仍然挂载");
    } finally {
        await cleanup();
    }
});

test("allowlist 内容相同但数组实例变化时不重复对账，并使用内容型依赖", async () => {
    const inputSource = sourceAt("web/src/app/(user)/canvas/components/canvas-prompt-chip-input.tsx");
    assert.ok(/const activeReferenceKey = useMemo\(/.test(inputSource), "allowlist 必须转换成内容 key");
    assert.ok(/Array\.from\(new Set\(activeReferenceIds\)\)\.sort\(\)\.join/.test(inputSource), "内容 key 必须忽略数组实例与顺序变化");
    assert.ok(
        /\}, \[activeReferenceKey, referenceByLabel, theme, tokens, value\]\);/.test(inputSource),
        "chip 对账 effect 必须依赖内容 key，不能直接依赖 activeReferenceIds 实例",
    );
    assert.equal(
        /\}, \[activeReferenceIds,/.test(inputSource),
        false,
        "activeReferenceIds 新数组实例不得直接触发 chip 对账 effect",
    );

    const { root, cleanup } = createTestRoot();
    let promptChanges = 0;
    let referenceChanges = 0;
    const render = async () => {
        await act(async () => {
            root.render(
                React.createElement(CanvasPromptChipInput, {
                    value: "图片1",
                    references: [reference("a", "图片1")],
                    activeReferenceIds: ["a"],
                    onChange: () => {
                        promptChanges += 1;
                    },
                    onReferenceIdsChange: () => {
                        referenceChanges += 1;
                    },
                    placeholder: "测试引用",
                }),
            );
        });
    };

    try {
        await render();
        await render();
        await render();
        await flushReactTimers();

        assert.equal(promptChanges, 0, "同内容 allowlist 不得重复改写 prompt");
        assert.equal(referenceChanges, 0, "同内容 allowlist 不得重复回调引用集合");
    } finally {
        await cleanup();
    }
});

test("同一 tick 多次取消选择合并提交，选择集合内容相同则不提交", () => {
    const panelSource = sourceAt("web/src/app/(user)/canvas/components/canvas-assistant-panel.tsx");
    assert.ok(/function hasSameNodeIds\(/.test(panelSource), "取消选择前必须比较集合内容，不能只比较 size");
    assert.ok(/pendingDeselectRef/.test(panelSource), "同一 tick 的选择取消必须合并");
    assert.ok(/deselectScheduledRef/.test(panelSource), "同一 tick 只能调度一次选择写回");
    assert.ok(/queueMicrotask\(/.test(panelSource), "选择取消应在当前 tick 末尾合并提交");
    assert.ok(
        /if\s*\(!hasSameNodeIds\(nextSelectedIds,\s*(?:pending\.base|currentSelectedIds)\)\)\s*onSelectNodeIds\(nextSelectedIds\)/.test(panelSource),
        "内容相同的选择集合不得调用 onSelectNodeIds",
    );
});

test("下层主动删除 chip 仍以 user 来源同步取消选中，且不删除真实节点", async () => {
    const { root, cleanup } = createTestRoot();
    const referenceChanges = [];
    const promptChanges = [];
    const render = async () => {
        await act(async () => {
            root.render(
                React.createElement(CanvasPromptChipInput, {
                    value: "图片1 图片2",
                    references: [reference("a", "图片1"), reference("b", "图片2")],
                    activeReferenceIds: ["a", "b"],
                    onChange: (next) => promptChanges.push(next),
                    onReferenceIdsChange: (ids, reason) => referenceChanges.push({ ids, reason }),
                    placeholder: "测试引用",
                }),
            );
        });
    };

    try {
        await render();
        const editor = document.querySelector('[role="textbox"]');
        const firstChip = editor?.querySelector("[data-ref-node-id='a']");
        assert.ok(editor && firstChip, "第一个引用 chip 必须存在");

        const range = document.createRange();
        range.setStart(editor, 0);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);

        await act(async () => {
            editor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
        });
        await flushReactTimers();

        assert.equal(editor.querySelector("[data-ref-node-id='a']"), null, "用户删除后对应 chip 必须消失");
        assert.deepEqual(referenceChanges.at(-1), { ids: ["b"], reason: "user" });
        assert.equal(promptChanges.at(-1)?.includes("图片1") ?? false, false, "prompt 必须和用户删除后的 chip 保持同步");
    } finally {
        await cleanup();
    }
});

test("上层与下层删除入口都会取消对应画布选择，且不删除真实节点", () => {
    const panelSource = sourceAt("web/src/app/(user)/canvas/components/canvas-assistant-panel.tsx");
    const inputSource = sourceAt("web/src/app/(user)/canvas/components/canvas-prompt-chip-input.tsx");
    const ast = ts.createSourceFile("canvas-assistant-panel.tsx", panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const definitions = helperDefinitions(ast);

    for (const attribute of ["onRemoveReference", "onReferenceIdsChange"]) {
        const expression = jsxAttribute(ast, attribute);
        assert.ok(expression, `${attribute} 必须接线`);
        assert.ok(
            reachesSelectionRemoval(expression, definitions),
            `${attribute} 删除引用时必须同步取消画布选择`,
        );
    }
    for (const name of ["removeComposerReferences", "removeComposerReference", "deselectNodeIds"]) {
        const definition = definitions.get(name);
        assert.ok(definition, `${name} 必须存在`);
        assert.equal(/\bdeleteNodes\s*\(/.test(definition.getText(ast)), false, `${name} 不能删除真实画布节点`);
    }
    assert.ok(
        /onReferenceIdsChangeRef\.current\?\.\(referenceIdsFromEditor\(editorRef\.current\), "user"\)/.test(inputSource),
        "用户退格/删除 chip 必须标记为 user，才能触发上层取消选中",
    );
});

test.after(() => {
    initialDom.window.close();
});
