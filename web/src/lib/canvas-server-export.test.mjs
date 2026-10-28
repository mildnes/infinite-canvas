import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const hookPath = new URL("../app/(user)/canvas/hooks/use-canvas-project-export.ts", import.meta.url);
const source = readFileSync(hookPath, "utf8");
const ticketUrl = id => `/api/v1/canvas/projects/${encodeURIComponent(id)}/export?ticket=signed-${encodeURIComponent(id)}`;
const serverTicket = id => ({ mode: "server", url: ticketUrl(id), expiresAt: "2099-01-01T00:00:00Z" });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ createTicket, token = "jwt-A", projects = [] } = {}) {
    const account = { token, user: token ? { id: "owner-A" } : null };
    const calls = [], downloads = [], notices = [];
    const state = { projects };
    let flushCalls = 0;
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    vm.runInNewContext(output, {
        exports, URL, Promise,
        fetch: () => { throw new Error("native export must not fetch ZIP bytes"); },
        window: { location: { origin: "https://canvas.example" } },
        document: {
            body: { appendChild() {} },
            createElement(tag) {
                assert.equal(tag, "a");
                return { href: "", download: undefined, click() { downloads.push({ href: this.href, download: this.download }); }, remove() {} };
            },
        },
        require(name) {
            if (name === "antd") return { App: { useApp: () => ({ message: { info: text => notices.push(text) } }) } };
            if (name === "@/stores/use-user-store") return { useUserStore: { getState: () => account } };
            if (name === "../stores/use-canvas-store") return {
                useCanvasStore: { getState: () => state },
                flushCanvasSaves: async () => { flushCalls++; state.projects = state.projects.map(project => ({ ...project, pendingSave: false })); },
            };
            if (name === "@/services/api/canvas-tasks") return {
                createCanvasProjectExportTicket: async (currentToken, id) => {
                    calls.push([currentToken, id]);
                    return createTicket ? createTicket({ currentToken, id, account }) : serverTicket(id);
                },
            };
            throw new Error(`unexpected import: ${name}`);
        },
    });
    return { run: exports.useCanvasProjectExport(), account, state, calls, downloads, notices, flushCalls: () => flushCalls };
}

test("票据导出直接触发原生下载，不读取完整画板或 ZIP 字节", async () => {
    const f = fixture();
    assert.equal(await f.run(["board/中文"]), true);
    assert.deepEqual(f.calls, [["jwt-A", "board/中文"]]);
    assert.equal(f.downloads.length, 1);
    assert.equal(f.downloads[0].href, `https://canvas.example${ticketUrl("board/中文")}`);
    assert.equal(f.downloads[0].download, "");
    assert.equal(f.flushCalls(), 0);
    assert.ok(!/\bfetch\(|\.blob\(|loadProject\(/.test(source), "normal server export must not load project bodies or assemble a Blob");
});

test("多选逐画板取票据并分别原生下载，不回退浏览器打包", async () => {
    const f = fixture();
    assert.equal(await f.run(["first", "second", "first"]), true);
    assert.deepEqual(f.calls.map(call => call[1]), ["first", "second"]);
    assert.equal(f.downloads.length, 2);
    assert.ok(f.notices.includes("将分别下载 2 个画板压缩包"));
});

test("已同步画板的本地节点、聊天引用或混合素材都按 browser 响应回退", async () => {
    for (const project of [
        { id: "board", pendingSave: false, nodes: [{ metadata: { storageKey: "image:local" } }] },
        { id: "board", pendingSave: false, nodes: [], chatSessions: [{ messages: [{ references: [{ storageKey: "audio:chat" }] }] }] },
        { id: "board", pendingSave: false, nodes: [{ metadata: { storageKey: "server:cloud" } }], chatSessions: [{ messages: [{ images: [{ storageKey: "image:chat" }] }] }] },
    ]) {
        const f = fixture({ projects: [project], createTicket: async () => ({ mode: "browser", localAssetCount: 1 }) });
        assert.equal(await f.run(["board"]), false);
        assert.equal(f.flushCalls(), 0, "已同步画板不能依赖 pendingSave 判断本地素材");
        assert.deepEqual(f.calls, [["jwt-A", "board"]]);
        assert.equal(f.downloads.length, 0);
        assert.deepEqual(f.notices, ["画板包含本地素材，已使用兼容模式导出"]);
    }
});

test("多选最后一个画板返回 browser 前不启动任何下载，整组选中一起回退", async () => {
    let release;
    const f = fixture({ createTicket: async ({ id }) => id === "local"
        ? new Promise(resolve => { release = resolve; })
        : serverTicket(id),
    });
    const pending = f.run(["first", "second", "local"]);
    await tick();
    assert.deepEqual(f.calls.map(call => call[1]), ["first", "second", "local"]);
    assert.equal(f.downloads.length, 0, "所有画板预检结束前不能开始部分下载");
    release({ mode: "browser", localAssetCount: 2 });
    assert.equal(await pending, false);
    assert.equal(f.downloads.length, 0);
    assert.deepEqual(f.notices, ["画板包含本地素材，已使用兼容模式导出"]);
});

test("404、501 与网络错误回退兼容模式，鉴权失败不回退", async () => {
    for (const status of [404, 501, undefined]) {
        const f = fixture({ createTicket: async () => { throw Object.assign(new Error("unavailable"), { status }); } });
        assert.equal(await f.run(["board"]), false);
        assert.deepEqual(f.notices, ["已使用兼容模式导出"]);
        assert.equal(f.downloads.length, 0);
    }
    for (const status of [401, 403, 500]) {
        const f = fixture({ createTicket: async () => { throw Object.assign(new Error("rejected"), { status }); } });
        await assert.rejects(f.run(["board"]), /rejected/);
        assert.equal(f.notices.length, 0);
        assert.equal(f.downloads.length, 0);
    }
});

test("批量某个票据失败前不启动部分下载，兼容模式不会重复已开始的文件", async () => {
    const f = fixture({ createTicket: async ({ id }) => {
        if (id === "second") throw Object.assign(new Error("old server"), { status: 404 });
        return serverTicket(id);
    } });
    assert.equal(await f.run(["first", "second"]), false);
    assert.equal(f.downloads.length, 0);
});

test("同账号 JWT 轮换继续取新票据，换账号则丢弃迟到票据", async () => {
    const f = fixture({ createTicket: async ({ id, account }) => {
        account.token = "jwt-B";
        return serverTicket(id);
    } });
    assert.equal(await f.run(["first", "second"]), true);
    assert.deepEqual(f.calls.map(call => call[0]), ["jwt-A", "jwt-B"]);
    let release;
    const late = fixture({ createTicket: () => new Promise(resolve => { release = resolve; }) });
    const pending = late.run(["board"]);
    await tick();
    late.account.user = { id: "owner-B" };
    late.account.token = "owner-B-jwt";
    release(serverTicket("board"));
    await assert.rejects(pending, /登录账号已变化/);
    assert.equal(late.downloads.length, 0);
    assert.equal(late.notices.length, 0);
});

test("导出票据地址必须同源、匹配画板且包含 ticket", async () => {
    for (const url of ["https://evil.example/steal?ticket=x", ticketUrl("another"), "/api/v1/canvas/projects/board/export"]) {
        const f = fixture({ createTicket: async () => ({ ...serverTicket("board"), url }) });
        await assert.rejects(f.run(["board"]), /导出票据地址无效/);
        assert.equal(f.downloads.length, 0);
        assert.equal(f.notices.length, 0);
    }
});

test("游客保留浏览器导出；有未同步修改时先完成既有保存再取票据", async () => {
    const guest = fixture({ token: "" });
    assert.equal(await guest.run(["board"]), false);
    assert.equal(guest.calls.length, 0);
    assert.equal(guest.notices.length, 0);
    const pending = fixture({ projects: [{ id: "board", pendingSave: true }] });
    assert.equal(await pending.run(["board"]), true);
    assert.equal(pending.flushCalls(), 1);
    assert.equal(pending.calls.length, 1);
});

test("API 用带 Bearer 的 POST 申请单画板票据，转义画板 ID", async () => {
    const calls = [], exports = {};
    let response = serverTicket("a/b");
    const apiSource = readFileSync(new URL("../services/api/canvas-tasks.ts", import.meta.url), "utf8");
    vm.runInNewContext(ts.transpileModule(apiSource, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, {
        exports,
        require(name) {
            if (name === "@/services/api/request") return { apiPost: async (...args) => { calls.push(args); return response; } };
            if (name === "@/stores/use-user-store") return { useUserStore: { getState: () => ({}) } };
            if (name.endsWith("canvas-project-hydration")) return {};
            throw new Error(`unexpected import: ${name}`);
        },
    });
    const ticket = await exports.createCanvasProjectExportTicket("current-jwt", "a/b");
    assert.equal(ticket.mode, "server");
    assert.equal(ticket.url, ticketUrl("a/b"));
    assert.equal(calls[0][0], "/api/v1/canvas/projects/a%2Fb/export");
    assert.equal(calls[0][2], "current-jwt");
    response = { mode: "browser", localAssetCount: 3 };
    assert.deepEqual(await exports.createCanvasProjectExportTicket("current-jwt", "a/b"), response);
});

test("卡片与列表先尝试票据下载，旧浏览器导出和缺失警告仍在降级分支", () => {
    for (const path of ["../app/(user)/canvas/components/canvas-project-card.tsx", "../app/(user)/canvas/page.tsx"]) {
        const text = readFileSync(new URL(path, import.meta.url), "utf8");
        const nativeAt = text.indexOf("if (await tryServerExport(");
        const hydrateAt = text.indexOf("loadProject(", nativeAt);
        assert.ok(nativeAt >= 0 && hydrateAt > nativeAt, "native export must run before full board loading");
        assert.ok(text.includes("await exportCanvasProjects("), "compatibility export is retained");
        assert.ok(text.includes("result.missing.length") && text.includes("message.warning("), "compatibility export retains missing reports");
    }
});
