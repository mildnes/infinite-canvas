import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/(user)/image/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("image.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const image = { id: "image", dataUrl: "original.png", storageKey: "server:original", width: 100, height: 100, bytes: 10, durationMs: 2 };
const log = { id: "log", images: [image], references: [], categoryIds: [], errors: [], imageCount: 1, prompt: "原提示词", model: "原模型", config: {}, status: "成功" };

function renderCard(name, props) {
    const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, `${name} 必须存在`);
    const stateChanges = [];
    const scope = {
        jsx: (type, attributes, ...children) => ({ type, props: { ...attributes, children } }),
        useState: (initial) => [initial, (value) => stateChanges.push(value)],
        useRef: () => ({ current: null }),
        useEffect: () => {},
        formatBytes: String,
        formatDuration: String,
        formatLogTime: String,
    };
    for (const component of ["Button", "Tag", "Image", "TaskInfo", "ReferenceThumbnailOverlay", "CloudUpload", "FolderPlus", "PenLine", "Brush", "Download", "Checkbox", "Trash2", "AlertCircle", "Copy", "ChevronUp", "ChevronDown", "RotateCcw", "Input", "Modal"]) {
        scope[component] = component;
    }
    const compiled = ts.transpileModule(`(${declaration.getText(ast)})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, jsxFactory: "jsx" },
    }).outputText;
    return { tree: vm.runInNewContext(compiled, scope)(props), stateChanges };
}

function maskButtons(tree) {
    if (Array.isArray(tree)) return tree.flatMap(maskButtons);
    if (!tree || typeof tree !== "object") return [];
    const children = tree.props?.children || [];
    const maskButton = tree.type === "Button" && (tree.props.title === "局部重绘" || children.some((child) => typeof child === "string" && child.trim() === "局部重绘"));
    return [...(maskButton ? [tree] : []), ...maskButtons(children)];
}

function resultCard(resultImage, onMaskEdit = assert.fail) {
    return renderCard("ResultImageCard", { result: { references: [] }, image: resultImage, index: 0, syncing: false, onMaskEdit });
}

function historyCard(record, onMaskEdit = assert.fail) {
    return renderCard("HistoryLogCard", { log: record, categories: [], index: 0, selected: false, active: false, syncing: false, onMaskEdit });
}

test("结果卡没有可显示图片时不渲染局部重绘入口", () => {
    const { tree } = resultCard({ ...image, dataUrl: "" });
    assert.equal(maskButtons(tree).length, 0);
});

test("结果卡有图片时保留局部重绘入口并传递原图", () => {
    const opened = [];
    const { tree } = resultCard(image, (selectedImage) => opened.push(selectedImage));
    const buttons = maskButtons(tree);
    assert.equal(buttons.length, 1);
    buttons[0].props.onClick();
    assert.equal(opened.length, 1);
    assert.equal(opened[0], image);
});

test("历史卡无图片或只有空 URL 时均不渲染局部重绘入口", () => {
    for (const status of ["成功", "失败", "生成中"]) {
        for (const images of [[], [{ ...image, dataUrl: "" }]]) {
            const { tree } = historyCard({ ...log, status, images });
            assert.equal(maskButtons(tree).length, 0, `${status}: ${images.length} 条图片记录`);
        }
    }
});

test("历史卡保留局部重绘入口，关闭分类菜单并传递首张可显示原图", () => {
    const opened = [];
    const record = { ...log, images: [{ ...image, id: "empty", dataUrl: "" }, image, { ...image, id: "second", dataUrl: "second.png" }] };
    const { tree, stateChanges } = historyCard(record, (selectedImage) => opened.push(selectedImage));
    const buttons = maskButtons(tree);
    assert.equal(buttons.length, 1);
    buttons[0].props.onClick();
    assert.equal(opened.length, 1);
    assert.equal(opened[0], image);
    assert.deepEqual(stateChanges, [false]);
});
