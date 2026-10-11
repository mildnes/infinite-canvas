import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { UserGroupEditor } from "./user-group-editor.tsx";
import { normalizeUserGroups } from "@/lib/user-groups";

test("真实分组编辑器 DOM：默认组不可删改 ID，白名单、全量开关、添加入口可见", () => {
    const groups = [...normalizeUserGroups(undefined, []), { id: "vip", name: "VIP", unrestricted: false, models: ["allowed"], isDefault: false }];
    const html = renderToStaticMarkup(createElement(UserGroupEditor, { groups, models: ["allowed"], onChange: () => {} }));
    const document = new JSDOM(html).window.document;
    const ids = [...document.querySelectorAll('input[aria-label="分组 ID"]')];
    assert.equal(ids[0].disabled, true);
    assert.equal(ids[1].disabled, false);
    assert.ok(document.querySelector('button[title="内置默认分组不可删除"]')?.disabled);
    assert.ok(document.querySelector('[aria-label="分组允许模型"]'));
    assert.equal(document.querySelectorAll('[aria-label="不限制模型"]').length, 2);
    assert.ok(document.body.textContent.includes("白名单为空 = 该组无任何可用模型"));
    assert.ok(document.body.textContent.includes("添加分组"));
});

test("真实分组编辑器操作回调：新增、编辑、切换不限制及删除同一数据源", () => {
    let groups = normalizeUserGroups(undefined, []);
    const render = () => UserGroupEditor({ groups, models: ["allowed"], onChange: value => { groups = value; } });
    render().props.children.at(-1).props.onClick();
    assert.equal(groups.length, 2);
    const card = render().props.children[1][1];
    card.props.children.props.children[0].props.children[1].props.onChange({ target: { value: "贵宾" } });
    assert.equal(groups[1].name, "贵宾");
    render().props.children[1][1].props.children.props.children[1].props.children[0].props.onChange(true);
    assert.equal(groups[1].unrestricted, true);
    assert.deepEqual(groups[1].models, []);
    render().props.children[1][1].props.extra.props.onConfirm();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, "default");
});

test("设置页第三页签和模型选项使用保留表单值，不另设分组 CRUD 接口", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    assert.ok(source.includes('key: "groups", label: "用户分组"'));
    assert.ok(source.includes("<UserGroupEditor groups={userGroups} models={publicModels}"));
    assert.ok(source.includes('Form.useWatch(["public", "modelChannel", "availableModels"], { form, preserve: true })'));
});
