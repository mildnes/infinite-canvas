// 画布默认开关：网格吸附（48px）与图片信息默认开启
// 反假绿：把被测文件回退到基线后，本文件应全部失败
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const pagePath = "web/src/app/(user)/canvas/[id]/canvas-client-page.tsx";
const layoutPath = "web/src/app/(user)/canvas/utils/canvas-layout.ts";

function read(path) {
    return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

const page = read(pagePath);
const layout = read(layoutPath);

test("网格吸附默认开启", () => {
    assert.ok(
        page.includes("const [snapToGrid, setSnapToGrid] = useState(true);"),
        "snapToGrid 的初始值应为 true",
    );
    assert.ok(
        !page.includes("const [snapToGrid, setSnapToGrid] = useState(false);"),
        "不应残留 snapToGrid 初始值 false",
    );
});

test("图片信息默认开启", () => {
    assert.ok(
        page.includes("const [showImageInfo, setShowImageInfo] = useState(true);"),
        "showImageInfo 的初始值应为 true",
    );
    assert.ok(
        !page.includes("const [showImageInfo, setShowImageInfo] = useState(false);"),
        "不应残留 showImageInfo 初始值 false",
    );
});

test("加载画板时缺省为 true，但保留用户明确关闭的选择", () => {
    // ?? 而不是 ||：已有画板显式存 false 时必须保持 false
    assert.ok(
        page.includes("setShowImageInfo(project.showImageInfo ?? true);"),
        "加载时应使用 project.showImageInfo ?? true",
    );
    assert.ok(
        page.includes("setSnapToGrid(project.snapToGrid ?? true);"),
        "加载时应使用 project.snapToGrid ?? true",
    );
    assert.ok(
        !page.includes("project.showImageInfo || false"),
        "不应残留 || false（会把显式 false 吞掉）",
    );
    assert.ok(
        !page.includes("project.snapToGrid ?? false"),
        "不应残留 ?? false",
    );
});

test("历史基线同步使用同一缺省规则", () => {
    assert.ok(
        page.includes("showImageInfo: project.showImageInfo ?? true,"),
        "历史基线应使用 project.showImageInfo ?? true",
    );
});

test("网格尺寸保持 48px", () => {
    assert.ok(
        layout.includes("export const CANVAS_GRID_SIZE = 48;"),
        "CANVAS_GRID_SIZE 应为 48",
    );
    assert.ok(
        layout.includes("snapToCanvasGrid(position: Position, gridSize = CANVAS_GRID_SIZE)"),
        "吸附应默认使用 CANVAS_GRID_SIZE",
    );
});

test("两个开关都参与保存签名，切换后会被持久化", () => {
    assert.ok(
        page.includes("canvasPersistSignature({ nodes, connections, chatSessions, activeChatId, agentConfig, backgroundMode, showImageInfo, showConnections, snapToGrid })"),
        "保存签名必须包含 showImageInfo 与 snapToGrid",
    );
    assert.ok(
        page.includes("updateProject(projectId, { nodes, connections, chatSessions, activeChatId, agentConfig, backgroundMode, showImageInfo, showConnections, snapToGrid });"),
        "保存时必须写入 showImageInfo 与 snapToGrid",
    );
});
