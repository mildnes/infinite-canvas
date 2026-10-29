import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const page = readFileSync(new URL("[id]/canvas-client-page.tsx", root), "utf8");
const store = readFileSync(new URL("stores/use-canvas-store.ts", root), "utf8");
const toolbar = readFileSync(new URL("components/canvas-toolbar.tsx", root), "utf8");

test("整理画板独立按钮接现有四列布局算法并进入画布历史", () => {
    assert.ok(/import \{[^}]*arrangeCanvasNodes[^}]*\} from "\.\.\/utils\/canvas-layout"/.test(page));
    assert.ok(/const arrangeCanvas = useCallback/.test(page));
    assert.ok(/arrangeCanvasNodes\(nodesRef\.current\)/.test(page));
    assert.ok(/setNodes\(arranged\)[\s\S]*persistCurrentCanvasRef\.current\(arranged\)/.test(page));
    assert.ok(/onArrangeCanvas=\{arrangeCanvas\}/.test(page));
    assert.ok(/整理画板/.test(toolbar));
    assert.ok(/onArrangeCanvas/.test(toolbar));
    assert.ok(/"tool-arrange"/.test(toolbar));
});

test("连线显示开关只控制持久连线、不阻止新建连线", () => {
    assert.ok(/const \[showConnections, setShowConnections\] = useState\(true\)/.test(page));
    assert.ok(/setShowConnections\(project\.showConnections \?\? true\)/.test(page));
    assert.ok(/showConnections,?\n?\s*showImageInfo/.test(page));
    assert.ok(/showConnections:\s*project\.showConnections \?\? true/.test(page));
    assert.ok(/\{showConnections \? \([\s\S]*connections\s*\n\s*\.filter[\s\S]*\.map[\s\S]*\) : null\}/.test(page));
    assert.ok(/\{connectingParams \? <ActiveConnectionPath/.test(page));
    assert.ok(/showConnections:\s*true/.test(store));
    assert.ok(/showConnections:\s*source\.showConnections \?\? true/.test(store));
    assert.ok(/showConnections \? "隐藏节点连线" : "显示节点连线"/.test(toolbar));
    assert.ok(/checked=\{showConnections\}/.test(toolbar));
    assert.ok(/showConnections=\{showConnections\}/.test(page));
    assert.ok(/onShowConnectionsChange=\{setShowConnections\}/.test(page));
    assert.ok(/setShowConnections\(entry\.showConnections\)/.test(page));
});

test("网格吸附开关持久化并在拖拽结束后只吸附本次移动节点", () => {
    assert.ok(/const \[snapToGrid, setSnapToGrid\] = useState\(true\)/.test(page));
    assert.ok(/setSnapToGrid\(project\.snapToGrid \?\? true\)/.test(page));
    assert.ok(/import \{[^}]*snapNodesToCanvasGrid[^}]*\} from "\.\.\/utils\/canvas-layout"/.test(page));
    assert.ok(/snapToGridRef\.current && !alignmentMatched \? snapNodesToCanvasGrid\(finalNodes, movedIds\) : finalNodes/.test(page));
    assert.ok(/snapToGrid=\{snapToGrid\}/.test(page));
    assert.ok(/onSnapToGridChange=\{setSnapToGrid\}/.test(page));
    assert.ok(/snapToGrid:\s*true/.test(store));
    assert.ok(/snapToGrid:\s*source\.snapToGrid \?\? true/.test(store));
    assert.ok(/网格吸附/.test(toolbar));
    assert.ok(/checked=\{snapToGrid\}/.test(toolbar));
});

test("节点对齐优先于网格吸附并在拖动期间显示辅助线", () => {
    assert.ok(/import \{[^}]*calculateCanvasAlignment[^}]*\} from "\.\.\/utils\/canvas-alignment"/.test(page));
    assert.ok(/alignmentContextRef\.current = createCanvasAlignmentContext/.test(page));
    assert.ok(/const aligned = calculateCanvasAlignment\(alignmentContextRef\.current/.test(page));
    assert.ok(/snapToGridRef\.current && !alignmentMatched/.test(page));
    assert.ok(/alignmentGuides=\{alignmentGuides\}/.test(page));
    assert.ok(/setAlignmentGuides\(\{\}\)/.test(page));
});

test("定向上传关闭多选，批量选择仍进入统一导入流程", () => {
    assert.ok(/imageInputRef\.current\.multiple = !nodeId/.test(page));
    assert.ok(/await importFiles\(files, position\)/.test(page));
    assert.ok(/const resetUploadInput = \(\) =>/.test(page));
});
