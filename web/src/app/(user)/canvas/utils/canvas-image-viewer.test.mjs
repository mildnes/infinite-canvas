import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import React, { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { previewSrcFor, fallbackCanvasPreview, loadOriginalImage } from "./canvas-image-preview.ts";

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
        React, useEffect, useRef, useState, previewSrcFor,
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
