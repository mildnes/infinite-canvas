import assert from "node:assert/strict";
import test from "node:test";
import { buildModelMappingRows, appendUpstreamModelRows, deriveModelMapping, ModelMappingEditor } from "./model-mapping-editor.tsx";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

test("映射行来源：已保存映射、未映射请求名、右列上游候选，保序去重", () => {
    const rows = buildModelMappingRows({ models: ["gpt-2.5-flare-4k"], modelMap: { "gpt-2.5-flare-4k": "gpt-image-2.5-flare" } }, ["gpt-image-2.5-flare", "gpt-image-2-high", "gpt-image-2-high"]);
    assert.deepEqual(rows.map(({ requestName, upstreamName }) => [requestName, upstreamName]), [["gpt-2.5-flare-4k", "gpt-image-2.5-flare"], ["", "gpt-image-2-high"]]);
    assert.deepEqual(buildModelMappingRows({ models: ["plain"], modelMap: { alias: "upstream" } }).map(({ requestName, upstreamName }) => [requestName, upstreamName]), [["alias", "upstream"], ["plain", ""]]);
});

test("只填右侧四行：保存为同名请求模型且无映射", () => {
    const models = ["a", "b", "c", "d"];
    assert.deepEqual(deriveModelMapping(buildModelMappingRows({}, models)), { models, modelMap: undefined });
});

test("左右都填与混合行：只暴露请求名，单侧直传，空行忽略", () => {
    const rows = buildModelMappingRows({}, ["gpt-image-2.5-sunburst", "b", "c", "d"]);
    rows[0].requestName = "我的高质图";
    rows[1].requestName = "自定义二";
    rows.push({ id: 99, requestName: "  ", upstreamName: "" });
    assert.deepEqual(deriveModelMapping(rows), { models: ["我的高质图", "自定义二", "c", "d"], modelMap: { "我的高质图": "gpt-image-2.5-sunburst", "自定义二": "b" } });
    assert.deepEqual(deriveModelMapping([{ id: 0, requestName: " same ", upstreamName: "same" }, { id: 1, requestName: "left", upstreamName: "" }]), { models: ["same", "left"], modelMap: undefined });
});

test("再拉取只追加右列新行，不改已填自定义名；删除不复活", () => {
    const rows = buildModelMappingRows({ models: ["alias"], modelMap: { alias: "upstream" } });
    const merged = appendUpstreamModelRows(rows, ["alias", "upstream", "new", "new"]);
    assert.deepEqual(merged[0], rows[0]);
    assert.deepEqual(merged.map(({ requestName, upstreamName }) => [requestName, upstreamName]), [["alias", "upstream"], ["", "new"]]);
    assert.deepEqual(deriveModelMapping(merged.filter(row => row.id !== rows[0].id)), { models: ["new"], modelMap: undefined });
});

test("真实映射表 DOM：表头、双列 AutoComplete、右列拉取结果、删除与添加可见", () => {
    const rows = buildModelMappingRows({}, ["gpt-image-2-high"]);
    const html = renderToStaticMarkup(createElement(ModelMappingEditor, { rows, requestModels: ["alias"], upstreamModels: ["gpt-image-2-high"], onChange: () => {}, onRemove: () => {}, onAdd: () => {} }));
    const document = new JSDOM(html).window.document;
    assert.deepEqual([...document.querySelectorAll("thead th")].map(el => el.textContent), ["请求模型名称（画板里显示/选择）", "上游模型名称（实际发给上游）", "操作"]);
    assert.equal(document.querySelector('input[aria-label="请求模型名称"]')?.getAttribute("value"), "");
    assert.equal(document.querySelector('input[aria-label="上游模型名称"]')?.getAttribute("value"), "gpt-image-2-high");
    assert.ok(document.querySelector('button[aria-label="删除映射行"]'));
    assert.ok([...document.querySelectorAll("button")].some(el => el.textContent?.includes("+ 添加映射")));
});
