import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import React, { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { previewSrcFor, loadOriginalImage } from "./canvas-image-preview.ts";

test("真实画布查看器：先预览、失败保留、重试原图、切图丢弃迟到回调", async (t) => {
    const dom = new JSDOM("<div id='root'></div>");
    const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(dom.window.document.getElementById("root"));
    t.after(async () => { await act(() => root.unmount()); Object.assign(globalThis, previous); dom.window.close(); });
    const source = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "FullscreenPreview");
    const code = ts.transpileModule(`(${declaration.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React } }).outputText;
    const loads = [];
    const FullscreenPreview = vm.runInNewContext(code, {
        React, useEffect, useRef, useState, previewSrcFor,
        loadOriginalImage: (src, callback) => loadOriginalImage(src, callback, () => { const image = {}; loads.push(image); return image; }),
        canvasThemes: { dark: { toolbar: { panel: "#222" }, node: { text: "#fff" } } }, useThemeStore: () => "dark",
    });
    const render = src => act(() => root.render(React.createElement(FullscreenPreview, { src, alt: "原图", onClose() {}, onDownload() {} })));
    const image = () => dom.window.document.querySelector("img");
    await render("/api/files/a/content");
    assert.equal(image().getAttribute("src"), "/api/files/a/preview");
    assert.equal(loads[0].src, "/api/files/a/content");
    await act(() => loads[0].onerror());
    assert.equal(image().getAttribute("src"), "/api/files/a/preview");
    assert.match(dom.window.document.body.textContent, /原图加载失败/);
    await act(() => dom.window.document.querySelector("button").click());
    const lateLoad = loads[1].onload;
    await render("/api/files/b/content");
    await act(() => lateLoad());
    assert.equal(image().getAttribute("src"), "/api/files/b/preview");
    const original = loads[2];
    const layoutBefore = image().className;
    await act(() => original.onload());
    assert.equal(image().getAttribute("src"), "/api/files/b/content");
    assert.equal(image().className, layoutBefore);
    assert.doesNotMatch(dom.window.document.body.textContent, /正在加载原图/);
    await render("/api/files/c/content");
    await act(() => image().dispatchEvent(new dom.window.Event("error")));
    assert.equal(image().getAttribute("src"), "/api/files/c/content");
});
