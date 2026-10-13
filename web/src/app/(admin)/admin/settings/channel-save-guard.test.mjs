import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let persist, load;
function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "persistChannels") persist = node.getText(ast);
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "loadSettings") load = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
}
visit(ast);

function fixture() {
    const writes = [], errors = [];
    const settingsLoadedRef = { current: false };
    const data = { public: { modelChannel: { availableModels: [], availableWorkflows: [], userGroups: [] } }, private: { channels: [{ id: "first" }, { id: "second" }] } };
    const context = { settingsLoadedRef, token: "t", message: { error: text => errors.push(text), success: () => {} },
        form: { getFieldsValue: () => data, setFieldsValue: () => {} }, normalizeSettings: v => v, normalizeUserGroups: () => [], availableUserGroupModels: () => [],
        collectChannelWorkflows: () => [], collectChannelModels: v => v.map(c => c.id), filterModels: v => v, resolveAvailableModels: v => v,
        savedRequestModelNamesRef: { current: [] }, savedUserGroupsRef: { current: [] },
        saveAdminSettings: async (_token, value) => { writes.push(value); return value; }, fetchAdminSettings: async () => data,
        clearImageStorageConfigCache: () => {}, clearMediaStorageConfigCache: () => {}, mergeChannelApiKeys: (_channels, saved) => saved,
        setChannels: () => {}, setModelCosts: () => {}, rememberKnownModels: () => {}, notifyPublicSettingsUpdated: () => {}, setJsonText: () => {},
        setIsLoading: () => {}, setHasLoadedSettings: () => {}, setKnownModels: () => {}, collectKnownModels: () => [],
    };
    vm.runInNewContext(ts.transpileModule(persist + '\nconst load = ' + load + ';', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
    return { context, writes, errors, data, settingsLoadedRef };
}

test("未成功加载的渠道保存不写入并明确提示", async () => {
    const f = fixture();
    await assert.rejects(f.context.persistChannels([{ id: "new" }]), /设置尚未加载完成/);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.errors, ["设置尚未加载完成，已阻止覆盖保存"]);
});

test("加载失败后 loading 已结束仍阻止渠道覆盖保存", async () => {
    const f = fixture();
    f.context.fetchAdminSettings = async () => { throw new Error("fixture load failed"); };
    await vm.runInNewContext('load()', f.context);
    assert.equal(f.settingsLoadedRef.current, false);
    await assert.rejects(f.context.persistChannels([{ id: "new" }]), /设置尚未加载完成/);
    assert.equal(f.writes.length, 0);
});

test("成功加载后渠道保存原载荷不变，按钮同时受 loading 与成功标记控制", async () => {
    const f = fixture();
    await vm.runInNewContext('load()', f.context);
    assert.equal(f.settingsLoadedRef.current, true);
    const channels = [...f.data.private.channels, { id: "new" }];
    await f.context.persistChannels(channels);
    assert.deepEqual(JSON.parse(JSON.stringify(f.writes[0].private.channels)), channels);
    assert.ok(source.includes('disabled={isLoading || !hasLoadedSettings}'));
});
