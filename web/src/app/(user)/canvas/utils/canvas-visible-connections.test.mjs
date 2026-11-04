import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("canvas.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
let connectionSvg;
function walk(node) {
    if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) declarations.set(node.name?.getText(ast), node);
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "svg" && node.getText(ast).includes("<ConnectionPath")) connectionSvg = node;
    ts.forEachChild(node, walk);
}
walk(ast);
assert.ok(connectionSvg, "the persistent and active connection SVG must be present");
const renderCode = ts.transpileModule([
    ...["isHiddenBatchChild", "isHiddenBatchConnectionEndpoint"].map(name => declarations.get(name).getText(ast)),
    ...["visibleNodes", "visibleNodeIds", "nodeById"].filter(name => declarations.has(name)).map(name => `const ${declarations.get(name).getText(ast)};`),
    `({ svg: (${connectionSvg.getText(ast)}), visibleNodes })`,
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React } }).outputText;

const node = (id, x = 0, metadata = {}, type = "image") => ({ id, type, position: { x, y: 0 }, width: 100, height: 100, metadata });
const connection = (id, fromNodeId, toNodeId) => ({ id, fromNodeId, toNodeId });
function createRenderer(nodes, connections) {
    const memos = [];
    return (changes = {}) => {
        let memoIndex = 0;
        return vm.runInNewContext(renderCode, {
            nodes, connections, viewport: { x: 0, y: 0, k: 1 }, size: { width: 800, height: 600 },
            containerRef: { current: null }, collapsingBatchIds: new Set(), showConnections: true,
            selectedConnectionId: null, relatedHighlight: { connectionIds: new Set() },
            connectingParams: null, mouseWorld: { x: 0, y: 0 }, connectionTargetNodeId: null,
            ConnectionPath: "ConnectionPath", ActiveConnectionPath: "ActiveConnectionPath",
            React: { createElement: (type, props, ...children) => ({ type, props, children }) },
            ...changes,
            useMemo: (derive, dependencies) => {
                const index = memoIndex++;
                const previous = memos[index];
                if (!previous || dependencies.some((value, position) => !Object.is(value, previous.dependencies[position]))) {
                    memos[index] = { dependencies, value: derive() };
                }
                return memos[index].value;
            },
        });
    };
}
const paths = rendered => rendered.svg.children.flat(Infinity).filter(child => child?.type === "ConnectionPath");
const pathIds = rendered => paths(rendered).map(path => path.props.connection.id);

test("持久连线只在至少一端属于真实 visibleNodes 时渲染", () => {
    const nodes = [node("visible-a"), node("visible-b", 200), node("off-a", 2000), node("off-b", 2200), node("off-left", -2000)];
    const connections = [
        connection("both-visible", "visible-a", "visible-b"),
        connection("from-visible", "visible-a", "off-a"),
        connection("to-visible", "off-a", "visible-b"),
        connection("both-offscreen", "off-a", "off-b"),
        connection("crossing-viewport", "off-left", "off-a"),
    ];
    const render = createRenderer(nodes, connections);
    assert.deepEqual(pathIds(render()), ["both-visible", "from-visible", "to-visible"]);
    assert.deepEqual(pathIds(render({ nodes: nodes.slice(2) })), []);
    assert.equal(connections.length, 5, "culling must not remove stored connections");
});

test("连线可见集合随平移、缩放和容器尺寸更新并沿用节点的预渲染范围", () => {
    const nodes = [node("near-edge", 1000), node("far", 2000)];
    const render = createRenderer(nodes, [connection("edge", "near-edge", "far")]);
    assert.deepEqual(pathIds(render()), ["edge"], "the existing 280px world-space padding still applies");
    assert.deepEqual(pathIds(render({ viewport: { x: 0, y: 0, k: 2 } })), []);
    assert.deepEqual(pathIds(render({ viewport: { x: -2000, y: 0, k: 1 } })), ["edge"]);
    assert.deepEqual(pathIds(render({ size: { width: 400, height: 600 } })), []);
    const rect = { getBoundingClientRect: () => ({ width: 1200, height: 600 }) };
    assert.deepEqual(pathIds(render({ containerRef: { current: rect }, size: { width: 1200, height: 600 } })), ["edge"]);
});

test("组和组内节点分别按自身 visibleNodes 判断，不扩大组内离屏连线", () => {
    const nodes = [node("group", 0, {}, "group"), node("member", 2000, { groupId: "group" }), node("far", 2200)];
    const render = createRenderer(nodes, [
        connection("group-edge", "group", "far"),
        connection("member-edge", "member", "far"),
    ]);
    assert.deepEqual(pathIds(render()), ["group-edge"]);
    const moved = nodes.map(item => item.id === "member" ? { ...item, position: { x: 0, y: 0 } } : { ...item, position: { x: 2000, y: 0 } });
    assert.deepEqual(pathIds(render({ nodes: moved })), ["member-edge"]);
});

test("折叠批量子节点的双向连线保持隐藏，收起动画也不重新显示连线", () => {
    const nodes = [
        node("batch", 0, { imageBatchExpanded: false }),
        node("child", 200, { batchRootId: "batch" }),
        node("visible", 400),
    ];
    const render = createRenderer(nodes, [
        connection("root-edge", "batch", "visible"),
        connection("child-from", "child", "visible"),
        connection("child-to", "visible", "child"),
    ]);
    const collapsed = render();
    assert.deepEqual(Array.from(collapsed.visibleNodes, item => item.id), ["batch", "visible"]);
    assert.deepEqual(pathIds(collapsed), ["root-edge"]);
    const collapsing = render({ collapsingBatchIds: new Set(["batch"]) });
    assert.ok(collapsing.visibleNodes.some(item => item.id === "child"), "the animation still renders its child node");
    assert.deepEqual(pathIds(collapsing), ["root-edge"], "the existing hidden endpoint check still applies during animation");
    const expanded = nodes.map(item => item.id === "batch" ? { ...item, metadata: { imageBatchExpanded: true } } : item);
    assert.deepEqual(pathIds(render({ nodes: expanded })), ["root-edge", "child-from", "child-to"]);
    assert.deepEqual(pathIds(render({ nodes: nodes.slice(1) })), ["child-from", "child-to"], "a missing batch root must retain the existing orphan-child behavior");
});

test("节点删除后的悬空连线保持不渲染，裁剪不改写连接数据", () => {
    const nodes = [node("from"), node("to", 200)];
    const connections = [
        connection("valid", "from", "to"),
        connection("missing-from", "deleted", "to"),
        connection("missing-to", "from", "deleted"),
    ];
    const snapshot = JSON.stringify(connections);
    const render = createRenderer(nodes, connections);
    assert.deepEqual(pathIds(render()), ["valid"]);
    assert.deepEqual(pathIds(render({ nodes: [nodes[0]] })), []);
    assert.deepEqual(pathIds(render({ nodes: [] })), []);
    assert.equal(JSON.stringify(connections), snapshot);
});

test("离屏裁剪和隐藏连线开关均不影响新建连线的 ActiveConnectionPath", () => {
    const nodes = [node("from", 2000), node("target", 2200)];
    const render = createRenderer(nodes, [connection("stored", "from", "target")]);
    for (const showConnections of [true, false]) {
        const rendered = render({ showConnections, connectingParams: { nodeId: "from", handleType: "output" }, connectionTargetNodeId: "target" });
        assert.deepEqual(pathIds(rendered), []);
        const active = rendered.svg.children.flat(Infinity).filter(child => child?.type === "ActiveConnectionPath");
        assert.equal(active.length, 1);
        assert.equal(active[0].props.node, nodes[0]);
        assert.equal(active[0].props.target, nodes[1]);
    }
    assert.deepEqual(pathIds(render({ viewport: { x: -2000, y: 0, k: 1 }, showConnections: false })), []);
    assert.deepEqual(pathIds(render({ viewport: { x: -2000, y: 0, k: 1 }, showConnections: true })), ["stored"]);
});
