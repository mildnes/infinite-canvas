import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { availableUserGroupModels, normalizeUserGroups } from "@/lib/user-groups";
import { deriveModelMapping } from "./model-mapping-editor.tsx";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
    if (ts.isVariableDeclaration(node) && node.initializer) functions.set(node.name.getText(ast), `const ${node.name.getText(ast)} = ${node.initializer.getText(ast)};`);
    ts.forEachChild(node, visit);
}
visit(ast);
const plain = value => JSON.parse(JSON.stringify(value));
const groups = () => [
    { id: "default", name: "默认用户", isDefault: true, unrestricted: false, models: [], scopes: [{ channelId: "c", model: "old" }] },
    { id: "vip", name: "VIP", isDefault: false, unrestricted: false, models: [], scopes: [{ channelId: "c", model: "old" }, { channelId: "other", model: "old" }] },
    { id: "all", name: "不限", isDefault: false, unrestricted: true, models: [], scopes: [] },
];
const channel = () => ({ id: "c", name: "GPT2", protocol: "openai", enabled: true, models: ["old"], modelMap: { old: "upstream-old" } });
function runtime(overrides = {}) {
    const messages = [], requests = [];
    const input = { private: { channels: [channel()] }, public: { modelChannel: { userGroups: groups(), availableModels: ["old", "new"], availableWorkflows: [], modelCosts: [] } } };
    const scope = {
        normalizeUserGroups, availableUserGroupModels, deriveModelMapping,
        normalizeSettings: value => value,
        normalizeChannel: value => value,
        isWorkflowProtocol: () => false,
        uniqueModels: values => [...new Set(values)],
        collectChannelModels: channels => [...new Set(channels.flatMap(channel => channel.models || []))],
        collectChannelWorkflows: () => [],
        resolveAvailableModels: values => values, filterModels: values => values,
        savedRequestModelNamesRef: { current: ["old"] }, savedUserGroupsRef: { current: groups() },
        savedChannelsRef: { current: [channel()] },
        originalModelRowsRef: { current: [{ id: 1, requestName: "old", upstreamName: "upstream-old" }] },
        settingsLoadedRef: { current: true }, token: "jwt-owner",
        form: { getFieldsValue: () => input, setFieldsValue: () => {}, getFieldValue: path => path.at(-1) === "userGroups" ? groups() : undefined },
        message: { success: text => messages.push(text), info: text => messages.push(text), warning: text => messages.push(text), error: text => messages.push(text) },
        saveAdminSettings: async (_token, value, renames) => { requests.push({ value: plain(value), renames: plain(renames || []) }); return value; },
        mergeChannelApiKeys: (_channels, saved) => saved,
        clearImageStorageConfigCache: () => {}, clearMediaStorageConfigCache: () => {},
        setChannels: () => {}, setModelCosts: () => {}, rememberKnownModels: () => {}, setJsonText: () => {},
        notifyPublicSettingsUpdated: () => {}, setNewGroupModelHints: () => {},
        ...overrides,
    };
    const names = ["prepareUserGroupsForSave", "modelRenamesFromRows", "renamedUserGroupBindingCount", "newModelsOutsideDefaultGroup", "addModelsToDefaultGroup", "notifyUserGroupScopeChanges", "persistChannels"];
    const code = names.filter(name => functions.has(name)).map(name => functions.get(name)).join("\n");
    vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
    return { scope, input, messages, requests };
}

test("保存渠道时旧失效 scope 原样交给后端联动，不在前端阻塞或静默丢弃", async () => {
    const h = runtime();
    await assert.doesNotReject(() => h.scope.persistChannels([]));
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0].value.public.modelChannel.userGroups[0].scopes, [{ channelId: "c", model: "old" }]);
    assert.deepEqual(h.requests[0].value.private.channels, []);
});

test("映射表行 ID 明确记录本地名和上游名同时变化，未改名/删除/新增不误报", () => {
    const h = runtime();
    assert.equal(typeof h.scope.modelRenamesFromRows, "function", "must record explicit rename pairs");
    const before = [{ id: 1, requestName: "old", upstreamName: "upstream-old" }, { id: 2, requestName: "keep", upstreamName: "" }, { id: 3, requestName: "removed", upstreamName: "" }];
    const after = [{ id: 1, requestName: " 高质量gpt-image-2 ", upstreamName: "gpt-image-2-high" }, before[1], { id: 4, requestName: "", upstreamName: "new-upstream" }];
    assert.deepEqual(plain(h.scope.modelRenamesFromRows("c", before, after)), [{ channelId: "c", from: "old", to: "高质量gpt-image-2" }]);
    assert.equal(before[0].requestName, "old");
});

test("删除旧映射行后添加新行，即使编辑器复用了行 ID 也不能被当作改名授权", () => {
    const original = [{ id: 1, requestName: "old", upstreamName: "upstream-old" }];
    const h = runtime({ modelMappingRows: original, originalModelRowsRef: { current: original }, setModelMappingRows: () => {}, commitModelMappingRows: () => {} });
    const remove = vm.runInNewContext(ts.transpileModule(functions.get("removeModelMapping") + "\nremoveModelMapping;", { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, h.scope);
    remove(original[0]);
    const added = [{ id: 1, requestName: "new", upstreamName: "upstream-new" }];
    assert.deepEqual(plain(h.scope.modelRenamesFromRows("c", h.scope.originalModelRowsRef.current, added)), []);
});

test("保存前预览所有受影响绑定数，忽略其他渠道与 unrestricted 分组", () => {
    const h = runtime();
    assert.equal(typeof h.scope.renamedUserGroupBindingCount, "function", "rename impact must be visible");
    assert.equal(h.scope.renamedUserGroupBindingCount(groups(), [{ channelId: "c", from: "old", to: "new" }]), 2);
    assert.ok(source.includes("条用户分组绑定"), "drawer must show the count before submitting");
});

test("真实渠道保存回调把显式改名对随渠道提交，包括同时更改上游名称", async () => {
    const h = runtime({
        modelMappingRows: [{ id: 1, requestName: "new", upstreamName: "upstream-new" }],
        editingChannelIndex: 0, channels: [channel()],
        channelForm: { validateFields: async () => channel(), getFieldsValue: () => channel() },
        workflowChannelDraft: {}, commitModelMappingRows: () => {}, rememberModels: () => {}, closeChannelDrawer: () => {},
    });
    const code = functions.get("saveChannel") + "\n saveChannel();";
    await vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, h.scope);
    assert.deepEqual(h.requests[0].renames, [{ channelId: "c", from: "old", to: "new" }]);
    assert.deepEqual(h.requests[0].value.private.channels[0].models, ["new"]);
});

test("新增模型默认不改白名单，只给出可见提示；一键加入仅授权指定渠道模型", () => {
    const h = runtime();
    assert.equal(typeof h.scope.newModelsOutsideDefaultGroup, "function", "new models need an explicit grant entry");
    const next = [{ ...channel(), models: ["old", "new", "new-two"] }];
    const hints = h.scope.newModelsOutsideDefaultGroup([channel()], next, groups());
    assert.deepEqual(plain(hints), [{ channelId: "c", channelName: "GPT2", models: ["new", "new-two"] }]);
    assert.deepEqual(groups()[0].scopes, [{ channelId: "c", model: "old" }]);
    const granted = h.scope.addModelsToDefaultGroup(groups(), hints, next);
    assert.deepEqual(plain(granted[0].scopes), [{ channelId: "c", model: "old" }, { channelId: "c", model: "new" }, { channelId: "c", model: "new-two" }]);
    assert.deepEqual(plain(granted[1]), groups()[1]);
    assert.deepEqual(plain(granted[2]), groups()[2]);
    assert.deepEqual(plain(h.scope.addModelsToDefaultGroup(granted, hints, next)), plain(granted));
    assert.ok(source.includes("尚未加入默认用户分组") && source.includes("一键加入默认用户分组"), "hint and explicit grant button must be rendered");
});

test("渠道顺序保持，已有模型/已有授权和 unrestricted 默认组不产生新增授权提示", () => {
    const h = runtime();
    assert.equal(typeof h.scope.newModelsOutsideDefaultGroup, "function");
    const saved = [channel(), { ...channel(), id: "other", name: "其他" }];
    assert.deepEqual(plain(h.scope.newModelsOutsideDefaultGroup(saved, [...saved].reverse(), groups())), []);
    const unrestricted = groups().map(group => group.id === "default" ? { ...group, unrestricted: true, scopes: [] } : group);
    assert.deepEqual(plain(h.scope.newModelsOutsideDefaultGroup(saved, [{ ...channel(), models: ["old", "new"] }], unrestricted)), []);
});

test("保存响应中的清理与改名可见，重复响应 cleaned 为空不重复提示", async () => {
    const h = runtime({
        saveAdminSettings: async (_token, value) => ({ ...value, cleaned: [{ groupId: "default", channelId: "c", model: "old", reason: "model_removed" }, { groupId: "vip", channelId: "c", model: "old", reason: "model_renamed" }] }),
    });
    await h.scope.persistChannels([channel()]);
    assert.ok(h.messages.some(text => text.includes("已自动清理 1 条失效引用")));
    assert.ok(h.messages.some(text => text.includes("1 条改名绑定")));
    h.messages.length = 0;
    h.scope.saveAdminSettings = async (_token, value) => ({ ...value, cleaned: [] });
    await h.scope.persistChannels([channel()]);
    assert.ok(!h.messages.some(text => text.includes("失效引用") || text.includes("改名绑定")));
});

test("一键加入使用真实按钮回调，授权后立即走保存请求而不是只改本地表单", async () => {
    const hints = [{ channelId: "c", channelName: "GPT2", models: ["new"] }];
    const h = runtime({ channels: [{ ...channel(), models: ["old", "new"] }], newGroupModelHints: hints });
    let click;
    function find(node) {
        if (ts.isJsxAttribute(node) && node.name.getText(ast) === "onClick" && node.initializer?.getText(ast).includes("addModelsToDefaultGroup")) click = node.initializer.expression.getText(ast);
        ts.forEachChild(node, find);
    }
    find(ast);
    assert.ok(click, "grant action must use the shared explicit-add function");
    vm.runInNewContext(ts.transpileModule(`(${click})();`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, h.scope);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0].value.public.modelChannel.userGroups[0].scopes, [{ channelId: "c", model: "old" }, { channelId: "c", model: "new" }]);
    assert.deepEqual(h.requests[0].value.public.modelChannel.userGroups[1].scopes, groups()[1].scopes);
});

test("总设置保存同样把旧 scope 交给后端，处理 cleaned 反馈并更新保存快照", async () => {
    const h = runtime({ collectSettings: async () => h.input, editorMode: {}, jsonText: {}, setIsSaving: () => {} });
    h.scope.saveAdminSettings = async (_token, value) => {
        h.requests.push({ value: plain(value) });
        return { ...value, cleaned: [{ groupId: "default", channelId: "c", model: "old", reason: "channel_removed" }] };
    };
    await vm.runInNewContext(ts.transpileModule(functions.get("saveSettings") + "\nsaveSettings();", { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, h.scope);
    assert.equal(h.requests.length, 1);
    assert.ok(h.messages.some(text => text.includes("已自动清理 1 条失效引用")));
    assert.deepEqual(plain(h.scope.savedChannelsRef.current), h.input.private.channels);
});

test("真实管理 API 包含顶层 modelRenames 且保留 public/private 与 cleaned 响应", async () => {
    const api = readFileSync(new URL("../../../../services/api/admin.ts", import.meta.url), "utf8");
    const apiAst = ts.createSourceFile("admin.ts", api, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = apiAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "saveAdminSettings");
    assert.ok(declaration);
    const requests = [];
    const scope = { apiPost: async (path, payload, token) => { requests.push({ path, payload: plain(payload), token }); return { ...payload, cleaned: [] }; } };
    const code = declaration.getText(apiAst).replace(/^export /, "") + "\nsaveAdminSettings;";
    const save = vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
    const input = { public: { modelChannel: { userGroups: groups() } }, private: { channels: [channel()] } };
    const renames = [{ channelId: "c", from: "old", to: "new" }];
    const response = await save("current-token", input, renames);
    assert.deepEqual(requests, [{ path: "/api/admin/settings", payload: { ...input, modelRenames: renames }, token: "current-token" }]);
    assert.deepEqual(response.cleaned, []);
    assert.equal(input.modelRenames, undefined);
});
