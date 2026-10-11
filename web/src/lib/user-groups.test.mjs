import assert from "node:assert/strict";
import test from "node:test";
import { availableUserGroupModels, normalizeUserGroups, userGroupLabel } from "./user-groups.ts";

test("分组默认兼容、显式限制与保存回读，不限制不展开成全量", () => {
    const initial = normalizeUserGroups(undefined, ["a"]);
    assert.deepEqual(initial, [{ id: "default", name: "默认用户", unrestricted: true, models: [], isDefault: true, remark: "" }]);
    const groups = normalizeUserGroups([...initial, { id: " vip ", name: " VIP ", models: ["a", "gone", "a"], unrestricted: false }], ["a"]);
    assert.deepEqual(groups[1].models, ["a"]);
    assert.deepEqual(normalizeUserGroups(JSON.parse(JSON.stringify(groups)), ["a"]), groups);
    assert.equal(userGroupLabel("", groups), "默认用户");
    assert.equal(userGroupLabel("missing", groups), "默认用户");
});

test("拒绝默认组删除／改身份、重复 ID、非空白名单失效；允许显式拒绝全部", () => {
    const saved = normalizeUserGroups(undefined, ["a"]);
    assert.throws(() => normalizeUserGroups([], ["a"], saved), /默认/);
    assert.throws(() => normalizeUserGroups([{ id: "vip", isDefault: true }], ["a"], saved), /默认/);
    assert.throws(() => normalizeUserGroups([...saved, { id: "default" }], ["a"], saved), /重复/);
    assert.throws(() => normalizeUserGroups([...saved, { id: "vip", models: ["gone"] }], ["a"], saved), /未开放/);
    assert.deepEqual(normalizeUserGroups([...saved, { id: "vip", models: [], unrestricted: false }], ["a"], saved)[1].models, []);
});

test("旧客户端省略分组字段时保留已保存分组，显式空数组仍拒绝删除默认组", () => {
    const saved = [...normalizeUserGroups(undefined, ["a"]), { id: "vip", name: "VIP", unrestricted: false, models: ["a"], isDefault: false, remark: "" }];
    assert.deepEqual(normalizeUserGroups(undefined, ["a"], saved), saved);
    assert.throws(() => normalizeUserGroups([], ["a"], saved), /默认/);
});

test("全局模型列表旧空值以启用渠道为全集，受限空白名单仍为空", () => {
    const settings = { public: { modelChannel: { availableModels: [] } }, private: { channels: [{ enabled: true, protocol: "openai", models: ["text"] }, { enabled: false, protocol: "openai", models: ["hidden"] }] } };
    assert.deepEqual(availableUserGroupModels(settings), ["text"]);
    const groups = [...normalizeUserGroups(undefined, []), { id: "vip", models: ["text"], unrestricted: false }, { id: "empty", models: [], unrestricted: false }];
    assert.deepEqual(normalizeUserGroups(groups, availableUserGroupModels(settings))[1].models, ["text"]);
    assert.deepEqual(normalizeUserGroups(groups, availableUserGroupModels(settings))[2].models, []);
    settings.public.modelChannel.availableModels = ["explicit"];
    assert.deepEqual(availableUserGroupModels(settings), ["explicit"]);
});
