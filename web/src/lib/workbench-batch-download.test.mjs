import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const pages = [
    {
        name: "生图工作台",
        source: readFileSync(new URL("../app/(user)/image/page.tsx", import.meta.url), "utf8"),
        functionName: "selectedImageLogImages",
        logs: [
            { id: "selected", images: [{ dataUrl: "data:image/png;base64,first" }, { dataUrl: "" }, { dataUrl: "data:image/png;base64,second" }] },
            { id: "unselected", images: [{ dataUrl: "data:image/png;base64,third" }] },
            { id: "empty", images: [] },
        ],
        selectedLogIds: ["selected", "empty"],
        expected: [
            { dataUrl: "data:image/png;base64,first" },
            { dataUrl: "data:image/png;base64,second" },
        ],
    },
    {
        name: "视频工作台",
        source: readFileSync(new URL("../app/(user)/video/page.tsx", import.meta.url), "utf8"),
        functionName: "selectedVideoLogVideos",
        logs: [
            { id: "selected", video: { url: "video-first" } },
            { id: "unselected", video: { url: "video-second" } },
            { id: "missing" },
        ],
        selectedLogIds: ["selected", "missing"],
        expected: [{ url: "video-first" }],
    },
];

for (const page of pages) {
    test(`${page.name}按已选日志派生可下载媒体并过滤空值`, () => {
        const ast = ts.createSourceFile("page.tsx", page.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === page.functionName);
        assert.ok(declaration, `页面应提供纯函数 ${page.functionName}`);
        const code = ts.transpileModule(`(${declaration.getText(ast).replace(/^export\s+/, "")})`, {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
        }).outputText;
        const derive = vm.runInNewContext(code);
        assert.deepEqual(JSON.parse(JSON.stringify(derive(page.logs, new Set(page.selectedLogIds)))), page.expected);
    });
}

test("两个工作台的下载按钮复用各自已有 onDownload，并与批量删除按钮并列", () => {
    const image = pages[0].source;
    const video = pages[1].source;
    assert.match(image, /const selectedImages = selectedImageLogImages\(visibleLogs, new Set\(selectedLogIds\)\)/);
    assert.match(image, /disabled=\{!selectedImages\.length\} onClick=\{\(\) => selectedImages\.forEach\(onDownload\)\}/);
    assert.match(video, /const selectedVideos = selectedVideoLogVideos\(visibleLogs, new Set\(selectedLogIds\)\)/);
    assert.match(video, /disabled=\{!selectedVideos\.length\} onClick=\{\(\) => selectedVideos\.forEach\(onDownload\)\}/);
    assert.ok(image.indexOf("disabled={!selectedImages.length}") > image.indexOf("disabled={!selectedLogIds.length} onClick={onDeleteSelected}"));
    assert.ok(video.indexOf("disabled={!selectedVideos.length}") > video.indexOf("disabled={!selectedLogIds.length} onClick={onDeleteSelected}"));
});
