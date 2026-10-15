import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../../../", import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
function loadModule(path, dependencies = {}) {
    let source = "";
    if (process.env.CATEGORY_SYNC_BASELINE) {
        try {
            source = execFileSync("git", ["show", `${process.env.CATEGORY_SYNC_BASELINE}:${path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        } catch { return {}; }
    } else {
        const file = new URL(path, root);
        if (!existsSync(file)) return {};
        source = readFileSync(file, "utf8");
    }
    const module = { exports: {} };
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, require: (name) => {
        assert.ok(name in dependencies, `unmocked dependency ${name}`);
        return dependencies[name];
    }, console });
    return module.exports;
}

function setup(initialRemote = {}, local = { categories: [], deletedCategories: [] }) {
    let remote = plain(initialRemote);
    let currentToken = "account-token";
    let currentUserId = "account-a";
    let fail = false;
    let onGet;
    let getCount = 0;
    const calls = [];
    const helper = loadModule("web/src/lib/image-log-categories.ts");
    const api = loadModule("web/src/services/api/user-config.ts", {
        "@/lib/image-log-categories": helper,
        "@/services/image-storage": { toProviderPayload: (value) => value },
        "@/services/api/request": {
            apiGet: async (url, params, token) => {
                calls.push({ method: "GET", url, token });
                if (fail) throw new Error("offline");
                onGet?.(++getCount);
                return plain(remote);
            },
            apiPost: async (url, body, token) => {
                calls.push({ method: "POST", url, token, body: plain(body) });
                remote = plain(body.data);
                return remote;
            },
        },
    });
    const storage = new Map([
        ["infinite-canvas:image_generation_categories", plain(local.categories)],
        ["infinite-canvas:image_generation_deleted_categories", plain(local.deletedCategories)],
    ]);
    const service = loadModule("web/src/services/image-categories.ts", {
        localforage: { createInstance: () => ({
            getItem: async (key) => plain(storage.get(key) ?? null),
            setItem: async (key, value) => { storage.set(key, plain(value)); return value; },
        }) },
        "@/lib/image-log-categories": helper,
        "@/services/api/user-config": api,
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ token: currentToken, user: { id: currentUserId } }) } },
    });
    return { api, service, calls, storage, remote: () => remote,
        fail: () => { fail = true; },
        switchOwner: (id, token) => { currentUserId = id; currentToken = token; },
        setRemote: (value) => { remote = plain(value); },
        onGet: (callback) => { onGet = callback; },
        switchOwnerOnGet: () => { onGet = () => { currentUserId = "account-b"; currentToken = "other-account"; }; } };
}

function exported(module, name) {
    assert.equal(typeof module[name], "function", `${name} must be exported`);
    return module[name];
}

test("分类 API 读改写保留既有 logs 和其它字段", async () => {
    const logs = [{ id: "unloaded", payload: "不得被分页截断" }];
    const context = setup({ logs, extra: "keep", categories: [] });
    const state = { categories: [{ id: "a", name: "本地", createdAt: 1 }], deletedCategories: [{ id: "old", deletedAt: 2 }] };
    await exported(context.api, "syncUserImageCategories")("account-token", state);
    assert.deepEqual(context.calls.map(({ method }) => method), ["GET", "POST"]);
    assert.deepEqual(context.remote(), { logs, extra: "keep", ...state });
    assert.ok(context.calls.every(({ token }) => token === "account-token"));
});

test("分类 API 兼容空远端与空 token，本地模式不发请求", async () => {
    const context = setup(null);
    const fetch = exported(context.api, "fetchUserImageCategories");
    const sync = exported(context.api, "syncUserImageCategories");
    assert.deepEqual(plain(await fetch("account-token")), { categories: [], deletedCategories: [] });
    context.calls.length = 0;
    assert.deepEqual(plain(await fetch("")), { categories: [], deletedCategories: [] });
    await sync("", { categories: [], deletedCategories: [] });
    assert.equal(context.calls.length, 0);
});

test("共享同步合并本地和远端分类，保留日志 blob", async () => {
    const a = { id: "a", name: "本地", createdAt: 1 };
    const b = { id: "b", name: "远端", createdAt: 2 };
    const context = setup({ categories: [b], logs: [{ id: "outside-page" }] }, { categories: [a], deletedCategories: [] });
    const result = await exported(context.service, "syncStoredImageCategories")("account-token", { categories: [a], deletedCategories: [] });
    assert.deepEqual(plain(result.categories), [a, b]);
    assert.deepEqual(context.remote().categories, [a, b]);
    assert.deepEqual(context.remote().logs, [{ id: "outside-page" }]);
});

test("A 设备已删除，B 设备陈旧分类同步后不复活", async () => {
    const category = { id: "deleted", name: "旧分类", createdAt: 1, updatedAt: 2 };
    const tombstone = { id: "deleted", deletedAt: 3 };
    const context = setup({ categories: [], deletedCategories: [tombstone] }, { categories: [category], deletedCategories: [] });
    const result = await exported(context.service, "syncStoredImageCategories")("account-token", { categories: [category], deletedCategories: [] });
    assert.deepEqual(plain(result), { categories: [], deletedCategories: [tombstone] });
    assert.deepEqual(context.storage.get("infinite-canvas:image_generation_categories:account-a"), []);
    assert.equal(context.calls.filter(({ method }) => method === "POST").length, 0);
});

test("相同分类不重复写回远端", async () => {
    const state = { categories: [{ id: "a", name: "已同步", createdAt: 1 }], deletedCategories: [] };
    const context = setup(state, state);
    await exported(context.service, "syncStoredImageCategories")("account-token", state);
    assert.deepEqual(context.calls.map(({ method }) => method), ["GET"]);
    assert.equal(exported(context.service, "sameImageCategoryState")(state, plain(state)), true);
});

test("离线同步失败仍保留本地新增分类及墓碑", async () => {
    const context = setup();
    context.fail();
    const state = { categories: [{ id: "new", name: "离线新增", createdAt: 4 }], deletedCategories: [{ id: "old", deletedAt: 3 }] };
    await assert.rejects(exported(context.service, "syncStoredImageCategories")("account-token", state), /offline/);
    assert.deepEqual(context.storage.get("infinite-canvas:image_generation_categories:account-a"), state.categories);
    assert.deepEqual(context.storage.get("infinite-canvas:image_generation_deleted_categories:account-a"), state.deletedCategories);
});

test("并发本地分类写入取并集，空 token 同步仅写本地", async () => {
    const context = setup();
    const write = exported(context.service, "writeStoredImageCategories");
    const a = { id: "a", name: "A", createdAt: 1 };
    const b = { id: "b", name: "B", createdAt: 2 };
    await Promise.all([write({ categories: [a], deletedCategories: [] }), write({ categories: [b], deletedCategories: [] })]);
    const result = await exported(context.service, "syncStoredImageCategories")("", { categories: [], deletedCategories: [] });
    assert.deepEqual(plain(result.categories), [a, b]);
    assert.equal(context.calls.length, 0);
});

test("拉取过程中切换账号，不把旧响应写回本地或远端", async () => {
    const a = { id: "local", name: "本地", createdAt: 1 };
    const b = { id: "remote", name: "旧账号远端", createdAt: 2 };
    const context = setup({ categories: [b] }, { categories: [a], deletedCategories: [] });
    context.switchOwnerOnGet();
    await exported(context.service, "syncStoredImageCategories")("account-token", { categories: [a], deletedCategories: [] });
    assert.deepEqual(context.storage.get("infinite-canvas:image_generation_categories"), [a]);
    assert.deepEqual(context.calls.map(({ method }) => method), ["GET"]);
});

test("读改写两次 GET 之间出现的远端新增分类和墓碑也保留", async () => {
    const old = { id: "old", name: "待删除", createdAt: 1 };
    const added = { id: "new", name: "本地新增", createdAt: 2 };
    const remoteAdded = { id: "remote-new", name: "别设备新增", createdAt: 3 };
    const tombstone = { id: "old", deletedAt: 4 };
    const context = setup({ categories: [old], deletedCategories: [], logs: [{ id: "keep" }] });
    context.onGet((count) => {
        if (count === 2) context.setRemote({ categories: [remoteAdded], deletedCategories: [tombstone], logs: [{ id: "keep" }] });
    });
    const result = await exported(context.service, "syncStoredImageCategories")("account-token", { categories: [old, added], deletedCategories: [] });
    assert.deepEqual(context.remote().categories, [added, remoteAdded]);
    assert.deepEqual(context.remote().deletedCategories, [tombstone]);
    assert.deepEqual(context.remote().logs, [{ id: "keep" }]);
    assert.deepEqual(plain(result), { categories: [added, remoteAdded], deletedCategories: [tombstone] });
});

test("分类本地副本按账号保存，切号不上传上一账号且旧本地数据保留", async () => {
    const a = { id: "a", name: "A 私人分类", createdAt: 1 };
    const state = { categories: [a], deletedCategories: [] };
    const context = setup({}, state);
    const sync = exported(context.service, "syncStoredImageCategories");
    const read = exported(context.service, "readStoredImageCategories");
    await sync("account-token", state);
    context.switchOwner("account-b", "other-account");
    context.setRemote({ categories: [], deletedCategories: [] });
    context.calls.length = 0;
    const b = await read();
    assert.deepEqual(plain(b), { categories: [], deletedCategories: [] });
    await sync("other-account", b);
    assert.deepEqual(context.remote().categories, []);
    assert.equal(context.calls.filter(({ method }) => method === "POST").length, 0);
    context.switchOwner("account-a", "account-token");
    assert.deepEqual(plain((await read()).categories), [a]);
    assert.deepEqual(context.storage.get("infinite-canvas:image_generation_categories"), [a]);
});

test("分类写回源码显式保留 image_history 原字段", () => {
    const source = readFileSync(new URL("web/src/services/api/user-config.ts", root), "utf8");
    const start = source.indexOf("export async function syncUserImageCategories");
    assert.ok(start >= 0, "syncUserImageCategories must exist");
    const body = source.slice(start, source.indexOf("\nexport ", start + 1));
    assert.match(body, /await fetchUserImageHistory/);
    assert.match(body, /\.\.\.existing/);
    assert.ok(body.indexOf("await fetchUserImageHistory") < body.indexOf("await syncUserImageHistory"));
});
