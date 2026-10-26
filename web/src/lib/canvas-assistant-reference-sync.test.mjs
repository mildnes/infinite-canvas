import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
const globals = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
};
for (const key of ["Node", "Element", "HTMLElement", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent", "PointerEvent"]) {
    globals[key] = dom.window[key];
}
Object.assign(globalThis, globals);
dom.window.requestAnimationFrame = globals.requestAnimationFrame;
dom.window.cancelAnimationFrame = globals.cancelAnimationFrame;

const { CanvasPromptChipInput } = await import("../app/(user)/canvas/components/canvas-prompt-chip-input.tsx");

const reference = (id, label) => ({
    id,
    nodeId: id,
    kind: "text",
    label,
    title: `节点 ${id}`,
    text: `内容 ${id}`,
    active: true,
});

test("上层引用集合移除已提交 chip 后，编辑区与 prompt 同步清理", async () => {
    const root = createRoot(document.getElementById("root"));
    const changes = [];
    const referenceIds = [];
    const value = "图片1 图片2";
    const render = async (references) => {
        await act(async () => {
            root.render(
                React.createElement(CanvasPromptChipInput, {
                    value,
                    references,
                    activeReferenceIds: references.map((item) => item.nodeId),
                    onChange: (next) => changes.push(next),
                    onReferenceIdsChange: (ids) => referenceIds.push(ids),
                    placeholder: "测试引用",
                }),
            );
        });
    };

    try {
        await render([reference("a", "图片1"), reference("b", "图片2")]);
        const editor = document.querySelector('[role="textbox"]');
        assert.ok(editor, "编辑区必须渲染");
        assert.deepEqual(
            [...editor.querySelectorAll("[data-ref-node-id]")].map((chip) => chip.dataset.refNodeId),
            ["a", "b"],
        );

        editor.focus();
        assert.equal(document.activeElement, editor, "引用移除必须覆盖编辑区聚焦场景");
        await render([reference("b", "图片2")]);

        assert.deepEqual(
            [...editor.querySelectorAll("[data-ref-node-id]")].map((chip) => chip.dataset.refNodeId),
            ["b"],
            "上层已删除的引用 chip 不得继续留在下层编辑区",
        );
        assert.equal(changes.at(-1)?.includes("图片1") ?? false, false, "prompt 不得继续序列化已删除引用");
        assert.deepEqual(referenceIds.at(-1), ["b"], "引用 ID 回调必须报告剩余引用");
    } finally {
        await act(async () => root.unmount());
        dom.window.close();
    }
});

function jsxAttribute(source, ast, name) {
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
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
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

test("上层与下层删除入口都会取消对应画布选择，且不删除真实节点", () => {
    const source = readFileSync(new URL("../app/(user)/canvas/components/canvas-assistant-panel.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("canvas-assistant-panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const definitions = helperDefinitions(ast);
    for (const attribute of ["onRemoveReference", "onReferenceIdsChange"]) {
        const expression = jsxAttribute(source, ast, attribute);
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
});
