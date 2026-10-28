import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const initialDom = installDom();
const { CanvasPromptChipInput } = await import("../app/(user)/canvas/components/canvas-prompt-chip-input.tsx");

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
        "Text",
        "Range",
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

function reference(id = "a", label = "文本1") {
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

function setup({ value = "", ids = [], references = [reference()], pendingReferences = [] } = {}) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const submissions = [];
    const referenceChanges = [];
    let current = { value, ids };
    let controls;

    function Harness() {
        const [prompt, setPrompt] = useState(value);
        const [activeIds, setActiveIds] = useState(ids);
        const [pending, setPending] = useState(pendingReferences);
        current = { value: prompt, ids: activeIds };
        controls = { setPrompt, setActiveIds, setPending };
        return React.createElement(CanvasPromptChipInput, {
            value: prompt,
            references,
            pendingReferences: pending,
            activeReferenceIds: activeIds,
            onChange: setPrompt,
            onReferenceIdsChange: (nextIds, reason) => referenceChanges.push({ ids: nextIds, reason }),
            onSubmit: (text, referenceIds) => {
                submissions.push({ text, referenceIds });
                setPrompt("");
                setActiveIds([]);
            },
            placeholder: "测试提示词",
        });
    }

    return {
        container,
        root,
        submissions,
        referenceChanges,
        current: () => current,
        editor: () => container.querySelector('[role="textbox"]'),
        async render() {
            await act(async () => root.render(React.createElement(Harness)));
        },
        async update(nextValue, nextIds, nextPending) {
            await act(async () => {
                controls.setPrompt(nextValue);
                controls.setActiveIds(nextIds);
                if (nextPending) controls.setPending(nextPending);
            });
        },
        async cleanup() {
            await act(async () => root.unmount());
            container.remove();
        },
    };
}

async function flushTimers() {
    await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 5));
    });
}

async function submitPrompt(t, focused) {
    const app = setup({ value: "请改写 文本1", ids: ["a"] });
    t.after(() => app.cleanup());
    await app.render();
    const editor = app.editor();
    assert.ok(editor);
    if (focused) editor.focus();

    await act(async () => {
        editor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    assert.deepEqual(app.submissions, [{ text: "请改写 文本1", referenceIds: ["a"] }]);
    assert.deepEqual(app.current(), { value: "", ids: [] });
    assert.equal(editor.textContent, "", "发送后编辑区必须保持清空");

    editor.append(document.createTextNode(" 第二次请求"));
    await act(async () => editor.dispatchEvent(new window.Event("input", { bubbles: true })));
    assert.equal(app.current().value, " 第二次请求", "继续输入不得带回上次已发送的提示词");
}

test("发送后同步清空提示词和引用，编辑区仍为空并可继续输入（焦点内）", async (t) => {
    await submitPrompt(t, true);
});

test("发送后同步清空提示词和引用，编辑区仍为空并可继续输入（失焦）", async (t) => {
    await submitPrompt(t, false);
});

test("外部替换文本与移除引用同时发生时，以新文本重建编辑区", async (t) => {
    const app = setup({ value: "旧内容 文本1", ids: ["a"] });
    t.after(() => app.cleanup());
    await app.render();

    await app.update("完全替换", []);

    assert.deepEqual(app.current(), { value: "完全替换", ids: [] });
    assert.equal(app.editor().textContent, "完全替换");
    assert.equal(app.editor().querySelector("[data-ref-node-id]"), null);
});

test("外部重建后待插引用不使用旧 caret range", async (t) => {
    const app = setup({ value: "旧文本", ids: [], references: [] });
    t.after(() => app.cleanup());
    await app.render();
    const editor = app.editor();
    const oldText = editor.firstChild;
    const range = document.createRange();
    range.setStart(oldText, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => editor.dispatchEvent(new window.Event("input", { bubbles: true })));

    await app.update("新的完整内容", [], [reference("b", "待插入")]);

    assert.equal(editor.firstChild.nodeType, Node.TEXT_NODE);
    assert.equal(editor.firstChild.textContent, "新的完整内容");
    assert.equal(editor.querySelector("[data-ref-node-id='b']")?.dataset.refNodeId, "b");
});

test("Backspace 主动删除引用仍通过 user 来源回调", async (t) => {
    const app = setup({ value: "文本1", ids: ["a"] });
    t.after(() => app.cleanup());
    await app.render();
    const editor = app.editor();
    const range = document.createRange();
    range.setStart(editor, editor.childNodes.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    await act(async () => {
        editor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    });
    await flushTimers();

    assert.equal(editor.querySelector("[data-ref-node-id]"), null);
    assert.deepEqual(app.referenceChanges.at(-1), { ids: [], reason: "user" });
});

test("IME 组合输入不提前同步，组合完成后的输入正常提交", async (t) => {
    const app = setup({ value: "", ids: [] });
    t.after(() => app.cleanup());
    await app.render();
    const editor = app.editor();
    editor.focus();

    await act(async () => {
        editor.textContent = "輸入中";
        editor.dispatchEvent(new window.InputEvent("input", { bubbles: true, isComposing: true }));
    });
    assert.equal(app.current().value, "", "组合中的临时文本不应提前同步");

    await act(async () => {
        editor.dispatchEvent(new window.InputEvent("input", { bubbles: true, isComposing: false }));
    });
    assert.equal(app.current().value, "輸入中");
});

test.after(() => {
    initialDom.window.close();
});
