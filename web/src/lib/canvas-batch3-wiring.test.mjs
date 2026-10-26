import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const baseline = process.env.CANVAS_BATCH3_BASELINE;
const pagePath = "web/src/app/(user)/canvas/[id]/canvas-client-page.tsx";
const layoutPath = "web/src/app/(user)/canvas/utils/canvas-layout.ts";

function sourceAt(path) {
    if (baseline) {
        try {
            return execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" });
        } catch {
            return "";
        }
    }
    return readFileSync(new URL(`../${path.replace(/^web\/src\//, "")}`, import.meta.url), "utf8");
}

const page = sourceAt(pagePath);
const layout = sourceAt(layoutPath);

test("Agent arrange_nodes 使用共享批次跟随函数，批次子图跟随根节点", () => {
    assert.ok(/import \{[^}]*offsetBatchChildren[^}]*\} from "\.\.\/utils\/canvas-layout"/.test(page),
        "画板页应从 canvas-layout 导入 offsetBatchChildren");
    assert.ok(/offsetBatchChildren\(nodesRef\.current, positions\)/.test(page),
        "Agent arrange_nodes 分支应调用 offsetBatchChildren 平移批次子图");

    // 复用当前 layout 源里的 offsetBatchChildren 做行为断言，保证批次相对位置不变。
    const exported = {};
    const output = ts.transpileModule(layout, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    vm.runInNewContext(output, {
        exports: exported,
        module: { exports: exported },
        require: () => ({}),
        console,
    });
    const nodes = [
        { id: "other", type: "image", position: { x: 100, y: 100 }, width: 100, height: 80, metadata: {} },
        { id: "root", type: "image", position: { x: 800, y: 800 }, width: 100, height: 80, metadata: { isBatchRoot: true, batchChildIds: ["child"] } },
        { id: "child", type: "image", position: { x: 840, y: 840 }, width: 100, height: 80, metadata: { batchRootId: "root" } },
    ];
    const positions = new Map([[ "root", { x: 272, y: 40 } ]]);
    exported.offsetBatchChildren(nodes, positions);
    assert.equal(positions.get("child").x, 312);
    assert.equal(positions.get("child").y, 80);
});

test("生成准备读参考图失败时会复位 runningNodeId 并提示真实原因", () => {
    assert.ok(/let generationContext: NodeGenerationContext;/.test(page),
        "generationContext 应先声明再在 try 内赋值");
    assert.ok(/try \{\s*generationContext = await hydrateNodeGenerationContext\(/.test(page),
        "hydrateNodeGenerationContext 应被纳入 try/catch");
    assert.ok(/catch \(error\) \{[\s\S]*setRunningNodeId\(null\);[\s\S]*return;/.test(page),
        "读参考图失败应复位 runningNodeId 后返回");
    assert.ok(/if \(!requireCanvasWriter\(\)\) \{\s*setRunningNodeId\(null\);/.test(page),
        "只读提前返回前应复位 runningNodeId");
});
