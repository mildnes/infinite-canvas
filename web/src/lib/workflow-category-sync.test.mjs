import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../components/workflows/creative-workflow-workspace.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("workflow.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration;
ts.forEachChild(ast, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "ensureWorkflowCategory") declaration = node;
});
assert.ok(declaration, "ensureWorkflowCategory must remain available for both generation paths");
const functionCode = ts.transpileModule(`(${declaration.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
const copy = (value) => JSON.parse(JSON.stringify(value));

function harness({ local = { categories: [], deletedCategories: [] }, remote, token = "account-token", syncError, afterSync } = {}) {
    let stored = copy(local);
    let syncCount = 0;
    const session = { token };
    const writes = [];
    const syncs = [];
    const warnings = [];
    const save = async (state) => {
        stored = copy(state);
        writes.push(copy(state));
        return copy(state);
    };
    const run = vm.runInNewContext(functionCode, {
        useUserStore: { getState: () => session },
        readStoredImageCategories: async () => copy(stored),
        writeStoredImageCategories: save,
        syncStoredImageCategories: async (ownerToken, state) => {
            syncs.push({ token: ownerToken, state: copy(state) });
            syncCount += 1;
            afterSync?.({ session, replaceStored: (value) => { stored = copy(value); } });
            if (syncError) throw syncError;
            if (syncCount === 1 && remote) stored = copy(remote);
            else stored = copy(state);
            return copy(stored);
        },
        resolveCategoryByName: (categories, name) => categories.find((item) => item.name.trim() === name.trim()),
        categorySyncFailedToken: "",
        categoryStore: {
            getItem: async () => copy(stored.categories),
            setItem: async (_key, categories) => save({ ...stored, categories }),
        },
        CATEGORY_STORE_KEY: "categories",
        nanoid: () => "new-category",
        Date: { now: () => 42 },
        console: { warn: (...args) => warnings.push(args) },
    });
    return { run, session, writes, syncs, warnings };
}

test("工作流先合并账号分类再按名称复用，换设备不创建同名分类", async () => {
    const remoteCategory = { id: "remote", name: "已有工作流", createdAt: 1, updatedAt: 2 };
    const state = harness({ remote: { categories: [remoteCategory], deletedCategories: [] } });
    assert.deepEqual(copy(await state.run(" 已有工作流 ", "account-token")), remoteCategory);
    assert.equal(state.syncs.length, 1);
    assert.equal(state.writes.length, 0);
});

test("工作流新建分类记录 updatedAt，并通过公共 helper 保存和同步", async () => {
    const state = harness();
    assert.deepEqual(copy(await state.run("新工作流", "account-token")), {
        id: "new-category", name: "新工作流", createdAt: 42, updatedAt: 42,
    });
    assert.equal(state.syncs.length, 2);
    assert.equal(state.writes.length, 1);
    assert.deepEqual(state.syncs[1].state.categories, state.writes[0].categories);
});

test("工作流不复用已被远端删除的旧 ID，显式新生成创建新分类并保留墓碑", async () => {
    const tombstone = { id: "deleted", deletedAt: 5 };
    const state = harness({
        local: { categories: [{ id: "deleted", name: "工作流", createdAt: 1 }], deletedCategories: [] },
        remote: { categories: [], deletedCategories: [tombstone] },
    });
    assert.equal((await state.run("工作流", "account-token")).id, "new-category");
    assert.deepEqual(state.writes[0].deletedCategories, [tombstone]);
    assert.deepEqual(state.writes[0].categories.map(({ id }) => id), ["new-category"]);
});

test("工作流分类同步失败重新读取本地并降级，同 token 后续生成不重复请求", async () => {
    const existing = { id: "other-tab", name: "工作流", createdAt: 1 };
    const state = harness({
        syncError: new Error("offline"),
        afterSync: ({ replaceStored }) => replaceStored({ categories: [existing], deletedCategories: [] }),
    });
    assert.equal((await state.run("工作流", "account-token")).id, "other-tab");
    assert.equal((await state.run("工作流", "account-token")).id, "other-tab");
    assert.equal(state.syncs.length, 1);
    assert.equal(state.warnings.length, 1);
    assert.equal(state.writes.length, 0);
});

test("工作流本地模式不调用账号同步，空名称不写入", async () => {
    const state = harness({ token: "" });
    assert.equal(await state.run(" ", ""), null);
    assert.equal((await state.run("本地工作流", "")).name, "本地工作流");
    assert.equal(state.syncs.length, 0);
    assert.equal(state.writes.length, 1);
});

test("工作流分类同步期间切号后停止，不把旧账号分类写回新会话", async () => {
    const state = harness({ afterSync: ({ session }) => { session.token = "other-token"; } });
    assert.equal(await state.run("工作流", "account-token"), null);
    assert.equal(state.writes.length, 0);
});

test("两条工作流生成路径使用提交时 token 接分类同步", () => {
    assert.equal((source.match(/ensureWorkflowCategory\(workflow\.name, token\)/g) || []).length, 2);
    assert.match(source, /from "@\/services\/image-categories"/);
});
