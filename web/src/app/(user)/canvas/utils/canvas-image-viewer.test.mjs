import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import React, { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { previewSrcFor, fallbackCanvasPreview, loadOriginalImage, previewContentHit } from "./canvas-image-preview.ts";

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
    const backfills = [];
    const state = { token: "owner" };
    const FullscreenPreview = vm.runInNewContext(code, {
        React, useEffect, useRef, useState, previewSrcFor, previewContentHit,
        X: () => React.createElement("svg"),
        loadOriginalImage: (src, callback) => loadOriginalImage(src, callback, () => { const image = {}; loads.push(image); return image; }),
        backfillStoragePreviewFromOriginal: (...args) => backfills.push(args),
        useUserStore: { getState: () => state },
        canvasThemes: { dark: { toolbar: { panel: "#222" }, node: { text: "#fff" } } }, useThemeStore: () => "dark",
    });
    const render = (src, storageKey = `server:${src.split("/").at(-2)}`) => act(() => root.render(React.createElement(FullscreenPreview, { src, storageKey, alt: "原图", onClose() {}, onDownload() {} })));
    const image = () => dom.window.document.querySelector("img");
    const loaded = async () => {
        Object.defineProperties(image(), { naturalWidth: { configurable: true, value: 20080 }, naturalHeight: { configurable: true, value: 22450 } });
        await act(() => image().dispatchEvent(new dom.window.Event("load")));
    };
    await render("/api/files/a/content");
    assert.equal(image().getAttribute("src"), "/api/files/a/preview?v=2");
    assert.equal(loads[0].src, "/api/files/a/content");
    await act(() => loads[0].onerror());
    assert.equal(image().getAttribute("src"), "/api/files/a/preview?v=2");
    assert.match(dom.window.document.body.textContent, /原图加载失败/);
    await act(() => dom.window.document.querySelector("button").click());
    const lateLoad = loads[1].onload;
    await render("/api/files/b/content");
    await act(() => lateLoad());
    assert.equal(image().getAttribute("src"), "/api/files/b/preview?v=2");
    const original = loads[2];
    const layoutBefore = image().className;
    await act(() => original.onload());
    assert.equal(image().getAttribute("src"), "/api/files/b/content");
    assert.equal(image().className, layoutBefore);
    assert.doesNotMatch(dom.window.document.body.textContent, /正在加载原图/);
    await loaded();
    assert.equal(backfills.length, 0, "正常预览切原图不补齐");
    await render("/api/files/c/content");
    await act(() => image().dispatchEvent(new dom.window.Event("error")));
    assert.equal(image().getAttribute("src"), "/api/files/c/content");
    assert.equal(backfills.length, 0, "预览失败时尚未加载原图");
    await loaded();
    assert.equal(backfills.length, 1);
    assert.deepEqual(Array.from(backfills[0].slice(0, 3)), ["/api/files/c/content", "server:c", "owner"]);
    assert.equal(backfills[0][3].width, 20080);
    assert.equal(backfills[0][3].height, 22450);
    await loaded();
    assert.equal(backfills.length, 1, "重复 load 不重复补齐");
    for (const key of ["server:webdav:path", undefined]) {
        await render("/api/files/invalid/content", key === undefined ? "" : key);
        await act(() => image().dispatchEvent(new dom.window.Event("error")));
        await loaded();
    }
    state.token = "";
    await render("/api/files/anonymous/content");
    await act(() => image().dispatchEvent(new dom.window.Event("error")));
    await loaded();
    assert.equal(backfills.length, 1);
    state.token = "owner";
    await render("/api/files/broken/content");
    await act(() => image().dispatchEvent(new dom.window.Event("error")));
    await act(() => image().dispatchEvent(new dom.window.Event("error")));
    assert.equal(backfills.length, 1, "原图解码失败不补齐、不循环重试");
});

test("真实全屏图片：留白四向关闭、内容与边缘不关、放大拖动防误关、X 只关闭一次", async (t) => {
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
    let closes = 0;
    const FullscreenPreview = vm.runInNewContext(code, {
        React, useEffect, useRef, useState, previewSrcFor, previewContentHit,
        X: () => React.createElement("svg"),
        loadOriginalImage: (src, callback) => loadOriginalImage(src, callback, () => { const image = {}; loads.push(image); return image; }),
        canvasThemes: { dark: { toolbar: { panel: "#222" }, node: { text: "#fff" } } }, useThemeStore: () => "dark",
    });
    const image = () => dom.window.document.querySelector("img");
    await act(() => root.render(React.createElement(FullscreenPreview, { src: "/api/files/wide/content", alt: "测试图", onClose: () => closes++, onDownload() {} })));
    const size = (width, height) => Object.defineProperties(image(), {
        naturalWidth: { configurable: true, value: width }, naturalHeight: { configurable: true, value: height },
        getBoundingClientRect: { configurable: true, value: () => ({ left: 120, top: 80, width: 1000, height: 800 }) },
        setPointerCapture: { configurable: true, value() {} }, releasePointerCapture: { configurable: true, value() {} },
    });
    const click = (x, y) => act(() => image().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: x, clientY: y })));
    size(0, 0);
    await click(620, 100);
    assert.equal(closes, 0, "未加载时不关闭");
    size(1024, 256);
    for (const [x, y] of [[620, 480], [121, 356], [1119, 604], [120, 355], [1120, 605]]) await click(x, y);
    assert.equal(closes, 0, "内容和边缘均不关闭");
    await click(620, 100);
    await click(620, 850);
    assert.equal(closes, 2, "预览上/下留白关闭");
    await act(() => loads[0].onload());
    size(300, 1200);
    await click(150, 480);
    await click(1100, 480);
    assert.equal(closes, 4, "原图按当前尺寸重新计算，左/右留白关闭");
    await click(521, 81);
    assert.equal(closes, 4);
    await act(() => image().dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1000 })));
    const pointer = (type, x, y) => act(() => image().dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })));
    await pointer("pointerdown", 620, 480);
    await pointer("pointermove", 720, 580);
    await pointer("pointerup", 720, 580);
    assert.match(image().style.transform, /translate\(100px, 100px\) scale\(2\)/);
    await click(1100, 480);
    assert.equal(closes, 4, "放大拖动后留白不误关闭");
    const close = dom.window.document.querySelector('button[aria-label="关闭预览"]');
    assert.ok(close?.querySelector("svg"));
    assert.match(close.className, /right-4 top-4 z-20/);
    await act(() => close.click());
    assert.equal(closes, 5, "X 不向背板重复冒泡关闭");
});

test("真实画布预览键盘回调：单图和批次均可 Esc 退出", () => {
    const source = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let handler;
    const visit = node => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handlePreviewKeyDown") handler = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const code = ts.transpileModule(`(${handler.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    for (const group of [[{ id: "a" }], [{ id: "a" }, { id: "b" }]]) {
        const closed = [];
        const keydown = vm.runInNewContext(code, {
            previewNodeId: "a", nodesRef: { current: group }, getBatchGroupNodes: () => group,
            setPreviewNodeId: value => closed.push(value),
        });
        let prevented = false;
        keydown({ key: "Escape", preventDefault: () => { prevented = true; } });
        assert.deepEqual(closed, [null]);
        assert.equal(prevented, true);
    }
});

test("真实图片节点：回退后用实际原图尺寸补齐，切图或原图失败不补齐", async (t) => {
    const dom = new JSDOM("<div id='root'></div>");
    const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(dom.window.document.getElementById("root"));
    t.after(async () => { await act(() => root.unmount()); Object.assign(globalThis, previous); dom.window.close(); });
    const source = readFileSync(new URL("../components/canvas-node.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("node.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ImageContent");
    const code = ts.transpileModule(`(${declaration.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React } }).outputText;
    const backfills = [], state = { token: "owner" };
    const ImageContent = vm.runInNewContext(code, {
        React, useRef, previewSrcFor, fallbackCanvasPreview,
        BatchFrame: ({ children }) => children,
        backfillStoragePreviewFromOriginal: (...args) => backfills.push(args),
        useUserStore: { getState: () => state },
        canvasThemes: { dark: {} }, useThemeStore: () => "dark",
    });
    const render = (id, key = `server:${id}`) => act(() => root.render(React.createElement(ImageContent, {
        node: Object.freeze({ id, title: id, metadata: Object.freeze({ content: `/api/files/${id}/content`, storageKey: key, naturalWidth: 0, naturalHeight: 0 }) }), isBatchRoot: false,
    })));
    const image = () => dom.window.document.querySelector("img");
    const fire = event => act(() => image().dispatchEvent(new dom.window.Event(event)));
    const loaded = async () => {
        Object.defineProperties(image(), { naturalWidth: { configurable: true, value: 11648 }, naturalHeight: { configurable: true, value: 8736 } });
        await fire("load");
    };
    await render("normal");
    await loaded();
    assert.equal(backfills.length, 0);
    await fire("error");
    assert.equal(image().getAttribute("src"), "/api/files/normal/content");
    assert.equal(backfills.length, 0);
    await loaded();
    assert.equal(backfills.length, 1);
    assert.equal(backfills[0][3].width, 11648);
    assert.equal(backfills[0][3].height, 8736);
    await loaded();
    assert.equal(backfills.length, 1);
    await render("old");
    await fire("error");
    await render("new");
    await loaded();
    assert.equal(backfills.length, 1, "旧图的回退不能补齐新图");
    await fire("error");
    await fire("error");
    assert.equal(backfills.length, 1, "原图失败不会循环补齐");
    await render("invalid", "server:webdav:path");
    await fire("error");
    await loaded();
    state.token = "";
    await render("anonymous");
    await fire("error");
    await loaded();
    assert.equal(backfills.length, 1);
});
