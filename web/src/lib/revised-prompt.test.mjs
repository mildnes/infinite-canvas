import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultConfig } from "../stores/use-config-store.ts";
import { useUserStore } from "../stores/use-user-store.ts";
import { requestGeneration } from "../services/api/image.ts";
import { canvasFixture, project, tick } from "./test-utils/canvas-store-fixture.mjs";

const root = new URL("../app/(user)/canvas/", import.meta.url);
const page = readFileSync(new URL("[id]/canvas-client-page.tsx", root), "utf8");
const toolbar = readFileSync(new URL("components/canvas-node-hover-toolbar.tsx", root), "utf8");
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
const pageAST = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const toolbarAST = ts.createSourceFile("toolbar.tsx", toolbar, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = (ast, names) => ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join("\n");

function updatedNode(revisedPrompt, userPrompt = "用户原始提示词") {
    const scope = {
        CanvasNodeType: { Image: "image" }, NODE_STATUS_SUCCESS: "success", NODE_STATUS_LOADING: "loading", NODE_STATUS_ERROR: "error",
        acceptsTaskUpdate: () => true, isStoppedTask: () => false, canvasImageTaskURLs: task => [task.image_url],
        canvasTaskCompleted: () => true, canvasTaskFailed: () => false, parseCanvasTaskTime: () => 1,
        isPanoramaNodeType: () => false, nodeSizeFromRatio: () => null, fitNodeSize: () => ({ width: 420, height: 236 }),
        NODE_DEFAULT_SIZE: { image: { width: 420, height: 236 } },
    };
    vm.runInNewContext(compile(declarations(pageAST, ["applyCanvasImageTaskUpdate"])), scope);
    const node = { id: "image", type: "image", title: "图片", width: 420, height: 236, position: { x: 0, y: 0 }, metadata: { status: "loading", prompt: userPrompt } };
    return scope.applyCanvasImageTaskUpdate([node], node.id, { id: "task", status: "completed", image_url: "/api/files/result/content", revisedPrompt }, 1, node)[0];
}

function renderInfo(node) {
    const scope = {
        exports: {}, React, useState: initial => [initial, () => {}], useEffect() {}, useMemo: callback => callback(),
        canvasThemes: { dark: { node: { fill: "#111", stroke: "#333", text: "#ddd" } } },
        useThemeStore: selector => selector({ theme: "dark" }), CanvasNodeType: { Image: "image" },
        isCanvasImageNodeType: type => type === "image", isPanoramaNodeType: () => false, getDataUrlByteSize: () => 0,
        Modal: ({ children }) => React.createElement("div", {}, children), Segmented: () => null, formatBytes: String,
    };
    vm.runInNewContext(compile(declarations(toolbarAST, ["CanvasNodeInfoModal", "InfoRow"])), scope);
    return renderToStaticMarkup(React.createElement(scope.CanvasNodeInfoModal, { node, open: true, onClose() {} }));
}

test("真实图片响应解析与持久化不丢 revised_prompt，缺失或非字符串时不报错", async t => {
    const previous = useUserStore.getState();
    const previousWindow = globalThis.window;
    useUserStore.setState({ token: "owner-token", user: { id: "owner" }, hydrateUser: async () => {} });
    globalThis.window = { location: { pathname: "/canvas/revised" }, setTimeout, clearTimeout };
    t.after(() => { useUserStore.setState(previous); if (previousWindow) globalThis.window = previousWindow; else Reflect.deleteProperty(globalThis, "window"); });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let revised;
    t.mock.method(globalThis, "fetch", async (url, init) => {
        if (String(url).includes("/images/generations")) return Response.json({ data: [{ b64_json: png, ...(revised === undefined ? {} : { revised_prompt: revised }) }] });
        if (String(url).startsWith("data:")) return new Response(Buffer.from(png, "base64"), { headers: { "Content-Type": "image/png" } });
        if (String(url) === "/api/v1/generated-media") return Response.json({ code: 0, data: { url: "/api/files/image/content", storageKey: "server:image", mimeType: "image/png" } });
        throw new Error(`unexpected request ${url}`);
    });
    const config = { ...defaultConfig, channelMode: "remote", model: "gpt-image-2.6-flare", imageModel: "gpt-image-2.6-flare", count: "1", imageOutputFormat: "auto", streamImages: false, publicChannels: [] };
    for (const value of ["模型改写后的提示词", "", undefined, null, 123]) {
        await t.test(`revised_prompt=${String(value)}`, async () => {
            revised = value;
            const [result] = await requestGeneration(config, "用户原始提示词");
            assert.equal(result.dataUrl, "/api/files/image/content");
            assert.equal(result.storageKey, "server:image");
            assert.equal(result.revisedPrompt, typeof value === "string" && value.trim() ? value : undefined);
        });
    }
});

test("任务完成写入独立 metadata.revisedPrompt，用户输入保持不变，保存重开仍展示", async () => {
    const node = updatedNode("模型改写后的提示词");
    assert.equal(node.metadata.prompt, "用户原始提示词");
    assert.equal(node.metadata.revisedPrompt, "模型改写后的提示词");
    const initial = { ...project("revised"), nodes: [node] };
    const fixture = canvasFixture({ owner: "anon", projects: [initial] });
    await tick();
    await fixture.flushCanvasSaves();
    const reopened = canvasFixture({ owner: "anon", disk: fixture.disk });
    await tick();
    const restored = reopened.useCanvasStore.getState().projects.find(item => item.id === "revised").nodes[0];
    assert.equal(restored.metadata.prompt, "用户原始提示词");
    assert.equal(restored.metadata.revisedPrompt, "模型改写后的提示词");
    const html = renderInfo(restored);
    assert.ok(html.includes("模型实际使用的提示词") && html.includes("模型改写后的提示词"));
    assert.ok(html.includes("<details"), "模型提示词必须使用折叠次要展示");
});

test("节点面板仅显示非空且不同的模型提示词，同值或缺失无空标题", async t => {
    for (const [revised, visible] of [["模型改写后的提示词", true], ["用户原始提示词", false], ["", false], [undefined, false]]) {
        await t.test(`revisedPrompt=${String(revised)}`, () => {
            const node = { id: "image", type: "image", title: "图片", width: 420, height: 236, position: { x: 0, y: 0 }, metadata: { prompt: "用户原始提示词", revisedPrompt: revised } };
            assert.equal(renderInfo(node).includes("模型实际使用的提示词"), visible);
        });
    }
});
