import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { canvasPromptFragment, copyCanvasPromptSelection, insertCanvasPromptFragment, serializeCanvasPromptNodes } from "./canvas-prompt-clipboard.ts";

function fixture(t, syntax) {
    const dom = new JSDOM("<div id='editor' contenteditable='true'></div><div id='outside'>outside</div>");
    t.after(() => dom.window.close());
    const document = dom.window.document;
    const editor = document.getElementById("editor");
    function chip(key) {
        const element = document.createElement("span");
        element.contentEditable = "false";
        element.title = "不能泄漏的图片标题";
        if (syntax === "label") element.dataset.refLabel = key;
        else element.dataset.referenceNodeId = key;
        const image = document.createElement("img");
        image.alt = "不能泄漏的图片标题";
        element.append(image);
        return element;
    }
    const token = syntax === "label" ? "@图片1" : "@[node:known]";
    const resolve = (key) => key === (syntax === "label" ? "图片1" : "known") ? chip(key) : undefined;
    const fragment = (text) => canvasPromptFragment(document, text, syntax, resolve, ["图片1"]);
    function select(start, startOffset, end = start, endOffset = startOffset) {
        const range = document.createRange();
        range.setStart(start, startOffset);
        range.setEnd(end, endOffset);
        const selection = dom.window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return range;
    }
    function clipboard(type) {
        const data = {};
        const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { setData: (format, value) => { data[format] = value; } } });
        editor.addEventListener(type, (event) => copyCanvasPromptSelection(editor, event, syntax, type === "cut"), { once: true });
        editor.dispatchEvent(event);
        return { data, event };
    }
    return { dom, document, editor, token, fragment, select, clipboard, syntax };
}

for (const syntax of ["label", "node"]) {
    test(`${syntax} 编辑器整段复制：纯文本引用，无标题／HTML，可回贴`, (t) => {
        const f = fixture(t, syntax);
        const text = `前缀 ${f.token} 后缀\n下一行 @[node:unknown] @未知引用`;
        f.editor.append(f.fragment(text));
        f.select(f.editor, 0, f.editor, f.editor.childNodes.length);
        const { data, event } = f.clipboard("copy");
        assert.equal(event.defaultPrevented, true);
        assert.deepEqual(data, { "text/plain": text });
        assert.ok(!data["text/plain"].includes("不能泄漏"));
        f.select(f.editor, 0, f.editor, f.editor.childNodes.length);
        assert.equal(insertCanvasPromptFragment(f.editor, f.fragment(data["text/plain"])), true);
        assert.equal(serializeCanvasPromptNodes(f.editor.childNodes, syntax), text);
        assert.equal(f.editor.querySelectorAll("img").length, 1);
    });

    test(`${syntax} 编辑器局部复制：按选区保留引用及 @ 前缀`, (t) => {
        const f = fixture(t, syntax);
        f.editor.append(f.fragment(`开始 ${f.token} 结束`));
        f.select(f.editor.firstChild, 2, f.editor.lastChild, 1);
        const { data } = f.clipboard("copy");
        assert.equal(data["text/plain"], ` ${f.token} `);
        assert.equal(serializeCanvasPromptNodes(f.editor.childNodes, syntax), `开始 ${f.token} 结束`);
    });

    test(`${syntax} 编辑器剪切：序列化后删除选区、恢复光标并同步值`, (t) => {
        const f = fixture(t, syntax);
        f.editor.append(f.fragment(`开始 ${f.token} 结束`));
        f.select(f.editor.firstChild, 2, f.editor.lastChild, 1);
        const { data, event } = f.clipboard("cut");
        assert.equal(data["text/plain"], ` ${f.token} `);
        assert.equal(event.defaultPrevented, true);
        assert.equal(serializeCanvasPromptNodes(f.editor.childNodes, syntax), "开始结束");
        assert.equal(f.dom.window.getSelection().isCollapsed, true);
        assert.equal(insertCanvasPromptFragment(f.editor, f.fragment(data["text/plain"])), true);
        assert.equal(serializeCanvasPromptNodes(f.editor.childNodes, syntax), `开始 ${f.token} 结束`);
    });

    test(`${syntax} 编辑器多行块、空行、BR 占位与局部跨行选区`, (t) => {
        const f = fixture(t, syntax);
        f.editor.innerHTML = "<div>第一行</div><div><br></div><div>第二行<br></div>";
        assert.equal(serializeCanvasPromptNodes(f.editor.childNodes, syntax), "第一行\n\n第二行");
        f.select(f.editor.firstChild.firstChild, 1, f.editor.lastChild.firstChild, 2);
        assert.equal(f.clipboard("copy").data["text/plain"], "一行\n\n第二");
    });

    test(`${syntax} 编辑器未知标记、换行与文字保持；失效引用不静默删除`, (t) => {
        const f = fixture(t, syntax);
        const text = `@图片999 @[node:deleted] @普通文本\n\n${f.token}\n`;
        f.editor.append(f.fragment(text));
        assert.equal(serializeCanvasPromptNodes(f.editor.childNodes, syntax), text);
        assert.equal(f.editor.querySelectorAll("img").length, 1);
    });

    test(`${syntax} 编辑器没有选区／选区在外部时不拦截剪贴板`, (t) => {
        const f = fixture(t, syntax);
        assert.equal(f.clipboard("copy").event.defaultPrevented, false);
        const outside = f.document.getElementById("outside");
        f.select(outside, 0, outside, 1);
        assert.equal(f.clipboard("cut").event.defaultPrevented, false);
        assert.equal(insertCanvasPromptFragment(f.editor, f.fragment("text")), false);
        assert.equal(outside.textContent, "outside");
    });
}

test("组装编辑器真实 chip 工厂：alt 为引用标记，标题仅作提示", async (t) => {
    const f = fixture(t, "node");
    const source = readFileSync(new URL("../components/canvas-config-composer.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("composer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "createReferenceChip");
    const code = ts.transpileModule(`(${declaration.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    const { previewSrcFor, fallbackCanvasPreview } = await import("./canvas-image-preview.ts");
    const create = vm.runInNewContext(code, { document: f.document, chipStyle: () => ({}), previewSrcFor, fallbackCanvasPreview });
    const chip = create({ nodeId: "known", title: "标题", type: "image", image: { dataUrl: "https://example.com/a.png" } }, [], {}, () => {});
    assert.equal(chip.querySelector("img").alt, "@[node:known]");
    assert.equal(chip.title, "标题");
});
