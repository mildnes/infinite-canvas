import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import axios from "axios";
import ts from "typescript";
import * as query from "@tanstack/react-query";
import { create } from "zustand";

import * as adminApi from "../services/api/admin.ts";

const require = createRequire(import.meta.url);
const src = new URL("../", import.meta.url);
const tick = async () => {
    for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const summary = (id) => ({
    id, createdAt: "2026-10-28T08:00:00Z", userId: "A", userDisplayName: "管理员",
    endpoint: "/v1/images/generations", method: "POST", model: "gpt-image-2",
    channelId: "channel", channelName: "渠道", status: 200, durationMs: 50, credits: 1,
});

function fixture(t, family = "ai-logs") {
    const dom = new JSDOM("<div id='root'></div>");
    const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(dom.window.document.getElementById("root"));
    const calls = [];
    const errors = [];
    const alerts = [];
    const pending = [];
    let respond = (config) => config.url === "/api/admin/settings"
        ? { public: {}, private: { aiLog: { localDirectReportEnabled: false } } }
        : { items: [summary(`page-${config.params?.page || 1}`)], total: 100 };
    const originalAdapter = axios.defaults.adapter;
    axios.defaults.adapter = async (config) => {
        calls.push(config);
        const data = await respond(config);
        return { data: { code: 0, data, msg: "" }, status: 200, statusText: "OK", headers: {}, config };
    };
    const useUserStore = create((set) => ({
        token: "token-A", user: { id: "A", role: "admin" },
        clearSession: () => set({ token: "", user: null }),
    }));
    const store = useUserStore;
    let table;
    let formProps;
    let input;
    let modal;
    let credit;
    let client;
    const buttons = new Map();
    const passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
    const Button = (props) => {
        const text = typeof props.children === "string" ? props.children : "";
        if (text) buttons.set(text, props);
        return null;
    };
    const Input = (props) => { input = props; return null; };
    Input.Search = Input;
    Input.TextArea = passthrough;
    const Form = (props) => { formProps = props; return React.createElement(React.Fragment, null, props.children); };
    Form.Item = passthrough;
    Form.useForm = () => [React.useMemo(() => ({ setFieldsValue() {}, validateFields: async () => ({}) }), [])];
    const Alert = (props) => {
        alerts.push(props);
        return React.createElement(React.Fragment, null, props.children, props.action);
    };
    const antd = {
        App: Object.assign(passthrough, { useApp: () => ({ message: messages }) }),
        ConfigProvider: passthrough,
        Alert,
        Button, Card: passthrough, Col: passthrough, Flex: passthrough, Form, Input,
        InputNumber: passthrough, Row: passthrough, Space: passthrough, Spin: passthrough,
        Switch: passthrough, Table: (props) => { table = props; return null; },
        Tag: passthrough, Tooltip: passthrough,
        Typography: { Text: passthrough },
        Modal: (props) => {
            if (family === "ai-logs") modal = props;
            return props.open ? React.createElement(React.Fragment, null, props.children) : null;
        },
    };
    const messages = { error: (value) => errors.push(value), success() {}, info() {} };
    const cache = new Map();
    const modules = {
        react: React,
        "react/jsx-runtime": require("react/jsx-runtime"),
        "@tanstack/react-query": {
            ...query,
            QueryClient: class extends query.QueryClient {
                constructor(options) { super(options); client = this; }
            },
        },
        antd,
        "@ant-design/icons": new Proxy({}, { get: () => passthrough }),
        "@ant-design/pro-components": {
            ProConfigProvider: passthrough,
            ProTable: (props) => { table = props; return null; },
        },
        "antd/locale/zh_CN": { default: {} },
        "@/services/api/admin": adminApi,
        "@/stores/use-user-store": { useUserStore },
        "@/stores/use-theme-store": { useThemeStore: (selector) => selector({ theme: "light" }) },
        "@/lib/app-theme": { getAntThemeConfig: () => ({}) },
        "@/components/layout/client-root-init": { ClientRootInit: passthrough },
    };
    function load(path) {
        if (cache.has(path)) return cache.get(path);
        const exports = {};
        cache.set(path, exports);
        const source = readFileSync(path, "utf8");
        vm.runInNewContext(ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
        }).outputText, {
            exports,
            require: (name) => {
                if (modules[name]) return modules[name];
                if (name.startsWith("@/")) return load(fileURLToPath(new URL(`${name.slice(2)}.ts`, src)));
                if (name.startsWith(".")) {
                    const file = new URL(name, `file://${path}`);
                    return load(fileURLToPath(new URL(`${file.href}.ts`)));
                }
                return require(name);
            },
            console, setTimeout, clearTimeout, AbortController, Error, Promise, document: dom.window.document,
        }, { filename: path });
        return exports;
    }
    const { AppProviders } = load(fileURLToPath(new URL("components/layout/app-providers.tsx", src)));
    let Page;
    if (family === "ai-logs") {
        Page = load(fileURLToPath(new URL("app/(admin)/admin/ai-logs/page.tsx", src))).default;
    } else {
        const { useAdminCreditLogs } = load(fileURLToPath(new URL("app/(admin)/admin/credit-logs/use-admin-credit-logs.ts", src)));
        Page = () => { credit = useAdminCreditLogs(); return null; };
    }
    const render = async (visible = true) => {
        await act(async () => {
            root.render(React.createElement(AppProviders, null, visible ? React.createElement(Page) : null));
            await tick();
        });
        await act(tick);
    };
    const rerender = async () => {
        await act(async () => {
            root.render(React.createElement(AppProviders, null, React.createElement(Page)));
            await tick();
        });
        await act(tick);
    };
    const change = async (fn) => {
        await act(async () => { await fn(); await tick(); });
        await rerender();
    };
    const changeWithoutRerender = async (fn) => {
        await act(async () => { await fn(); await tick(); });
    };
    const settle = async () => {
        await act(tick);
        await act(tick);
    };
    t.after(async () => {
        await act(async () => root.unmount());
        client?.clear();
        for (const item of pending) item.resolve?.({ items: [], total: 0 });
        if (originalAdapter) axios.defaults.adapter = originalAdapter;
        Object.assign(globalThis, previous);
        dom.window.close();
    });
    return {
        render, change, changeWithoutRerender, settle, calls, errors, messages, store, buttons,
        alerts,
        get client() { return client; },
        get table() { return table; },
        get credit() { return credit; },
        get input() { return input; },
        get form() { return formProps; },
        get modal() { return modal; },
        text: () => dom.window.document.getElementById("root")?.textContent || "",
        respond: (handler) => { respond = handler; },
        logCalls: () => calls.filter((call) => call.url === `/api/admin/${family}`),
        defer: () => {
            respond = (config) => config.url === "/api/admin/settings"
                ? { public: {}, private: { aiLog: {} } }
                : new Promise((resolve, reject) => pending.push({ config, resolve, reject }));
            return pending;
        },
    };
}

function allText(node) {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(allText).join(" ");
    return allText(node.props?.children);
}

for (const family of ["ai-logs", "credit-logs"]) {
    test(`${family}: a fresh list survives leaving and reopening the page without another request`, async (t) => {
        const f = fixture(t, family);
        await f.render();
        assert.equal(f.logCalls().length, 1);
        await f.render(false);
        await f.render();
        assert.equal(f.logCalls().length, 1, "reopening within 30 seconds must use the existing list");
        const entry = f.client.getQueryCache().getAll().find((item) => item.queryKey.includes(family));
        assert.equal(entry.options.staleTime, 30_000);
        assert.equal(entry.options.gcTime, 300_000);
    });

    test(`${family}: pagination and a failed new page retain rows; refresh retries the current page`, async (t) => {
        const f = fixture(t, family);
        await f.render();
        const pending = f.defer();
        await f.change(() => family === "ai-logs" ? f.table.pagination.onChange(2, 20) : f.credit.changePage(2));
        const rows = () => family === "ai-logs" ? f.table.dataSource : f.credit.logs;
        assert.equal(rows()[0]?.id, "page-1", "loading another page must keep the last visible rows");
        await f.change(() => pending[0].reject(new Error("offline")));
        assert.equal(rows()[0]?.id, "page-1", "a failed new query must not render an empty list");
        if (family === "ai-logs") assert.ok(f.alerts.some((item) => item.type === "error"));
        else assert.equal(f.errors.length, 1);
        await (family === "ai-logs" ? f.change(() => f.buttons.get("刷新").onClick()) : f.changeWithoutRerender(() => void f.credit.refreshLogs()));
        assert.equal(pending.at(-1).config.params.page, 2);
        assert.equal(rows()[0]?.id, "page-1", "retrying a failed new page must retain the last visible rows");
        assert.equal(family === "ai-logs" ? f.table.loading : f.credit.isLoading, false, "a retry with retained rows is not an initial load");
        await f.change(() => pending.at(-1).resolve({ items: [summary("retry-page-2")], total: 100 }));
        assert.equal(rows()[0]?.id, "retry-page-2");
    });

    test(`${family}: a late response for old parameters never replaces the active page`, async (t) => {
        const f = fixture(t, family);
        await f.render();
        const pending = f.defer();
        await f.change(() => family === "ai-logs" ? f.table.pagination.onChange(2, 20) : f.credit.changePage(2));
        await f.change(() => family === "ai-logs" ? f.table.pagination.onChange(3, 20) : f.credit.changePage(3));
        await f.change(() => pending[1].resolve({ items: [summary("page-3")], total: 100 }));
        await f.change(() => pending[0].resolve({ items: [summary("late-page-2")], total: 100 }));
        assert.equal((family === "ai-logs" ? f.table.dataSource : f.credit.logs)[0]?.id, "page-3");
    });

    test(`${family}: changing page size returns to the first page`, async (t) => {
        const f = fixture(t, family);
        await f.render();
        if (family === "ai-logs") {
            await f.change(() => f.table.pagination.onChange(3, 20));
            await f.change(() => f.table.pagination.onChange(3, 50));
            assert.equal(f.table.pagination.current, 1);
            assert.equal(f.logCalls().at(-1).config?.params?.page ?? f.logCalls().at(-1).params?.page, 1);
            assert.equal(f.logCalls().at(-1).config?.params?.pageSize ?? f.logCalls().at(-1).params?.pageSize, 50);
        } else {
            await f.change(() => f.credit.changePage(3));
            await f.change(() => f.credit.changePageSize(50));
            assert.equal(f.credit.page, 1);
            assert.equal(f.logCalls().at(-1).params.page, 1);
            assert.equal(f.logCalls().at(-1).params.pageSize, 50);
        }
    });
}

test("AI search submits draft and resets page atomically; reset and refresh use submitted conditions", async (t) => {
    const f = fixture(t);
    await f.render();
    await f.change(() => f.table.pagination.onChange(3, 20));
    const before = f.logCalls().length;
    await f.change(() => f.input.onChange({ target: { value: "needle" } }));
    assert.equal(f.logCalls().length, before, "typing must not query");
    await f.change(() => f.form.onFinish());
    assert.deepEqual(f.logCalls().slice(before).map((item) => [item.params.keyword, item.params.page]), [["needle", 1]]);
    await f.change(() => f.input.onChange({ target: { value: "unsubmitted" } }));
    await f.change(() => f.buttons.get("刷新").onClick());
    assert.equal(f.logCalls().at(-1).params.keyword, "needle");
    await f.change(() => f.buttons.get("重置").onClick());
    assert.equal(f.table.pagination.current, 1);
    assert.equal(f.input.value, "");
    assert.equal(f.table.dataSource[0]?.id, "page-1");
});

test("AI request/response details load on click, share cache, and retry a failed detail", async (t) => {
    const f = fixture(t);
    await f.render();
    assert.equal(f.calls.filter((item) => item.url?.startsWith("/api/admin/ai-logs/")).length, 0);
    let fail = true;
    f.respond((config) => {
        if (config.url.startsWith("/api/admin/ai-logs/")) {
            if (fail) throw new Error("offline");
            return { ...summary("page-1"), requestBody: "request", responseBody: "response", error: "" };
        }
        return { items: [summary("page-1")], total: 100 };
    });
    const actions = () => f.table.columns.find((column) => column.key === "actions").render(null, f.table.dataSource[0]).props.children;
    await f.change(() => actions()[0].props.onClick());
    assert.equal(f.calls.filter((item) => item.url?.startsWith("/api/admin/ai-logs/")).length, 1);
    await f.settle();
    assert.ok(f.buttons.has("重试"), "failed details must provide a retry action");
    assert.equal(f.table.dataSource[0]?.id, "page-1");
    fail = false;
    await f.change(() => f.buttons.get("重试").onClick());
    await f.settle();
    assert.ok(f.text().includes("request"));
    fail = true;
    await f.changeWithoutRerender(() => f.client.invalidateQueries({ queryKey: ["admin", "ai-logs", "detail"] }));
    await f.settle();
    assert.ok(f.text().includes("request"), "a failed detail refresh must retain the previous body");
    assert.ok(f.buttons.has("重试"), "a failed detail refresh must remain retryable");
    fail = false;
    await f.change(() => f.buttons.get("重试").onClick());
    await f.settle();
    await f.change(() => f.modal.onCancel());
    await f.change(() => actions()[1].props.onClick());
    await f.settle();
    assert.ok(f.text().includes("response"));
    assert.equal(f.calls.filter((item) => item.url?.startsWith("/api/admin/ai-logs/")).length, 4);
    const detail = f.client.getQueryCache().getAll().find((item) => item.queryKey.includes("detail"));
    assert.equal(detail.options.staleTime, 300_000);
    assert.equal(detail.options.gcTime, 300_000);
});

test("AI cleanup invalidates cached pages without refetching the old page", async (t) => {
    const f = fixture(t);
    await f.render();
    await f.change(() => f.table.pagination.onChange(3, 20));
    const before = f.logCalls().length;
    await f.change(() => f.buttons.get("清理旧日志").onClick());
    const refreshCalls = f.logCalls().slice(before);
    assert.deepEqual(refreshCalls.map((item) => item.params.page), [1]);
    assert.equal(f.table.pagination.current, 1);
});

test("AI cleanup refreshes the current first page after invalidating its cache", async (t) => {
    const f = fixture(t);
    await f.render();
    const before = f.logCalls().length;
    await f.change(() => f.buttons.get("清理旧日志").onClick());
    assert.deepEqual(f.logCalls().slice(before).map((item) => item.params.page), [1]);
});

test("AI detail closes immediately when the account changes", async (t) => {
    const f = fixture(t);
    f.respond((config) => {
        if (config.url.startsWith("/api/admin/ai-logs/")) {
            return { ...summary("page-1"), requestBody: "request", responseBody: "", error: "" };
        }
        return { items: [summary("page-1")], total: 1 };
    });
    await f.render();
    const actions = () => f.table.columns.find((column) => column.key === "actions").render(null, f.table.dataSource[0]).props.children;
    await f.change(() => actions()[0].props.onClick());
    await f.settle();
    assert.ok(f.text().includes("request"));
    await f.changeWithoutRerender(() => f.store.setState({ token: "token-B", user: { id: "B", role: "admin" } }));
    assert.equal(f.modal.open, false);
    assert.ok(!f.text().includes("request"));
});

test("AI detail never displays a previous record while a different id is loading", async (t) => {
    const f = fixture(t);
    f.respond((config) => {
        if (config.url.endsWith("/first")) return { ...summary("first"), requestBody: "first body", responseBody: "", error: "" };
        if (config.url.endsWith("/second")) return new Promise((resolve) => setTimeout(() => resolve({ ...summary("second"), requestBody: "second body", responseBody: "", error: "" }), 30));
        return { items: [summary("first"), summary("second")], total: 2 };
    });
    await f.render();
    const actions = (index) => f.table.columns.find((column) => column.key === "actions").render(null, f.table.dataSource[index]).props.children;
    await f.change(() => actions(0)[0].props.onClick());
    await f.settle();
    assert.ok(f.text().includes("first body"));
    await f.change(() => f.modal.onCancel());
    await f.change(() => actions(1)[0].props.onClick());
    assert.ok(!allText(f.modal.children).includes("first body"), "a different id must not reuse the previous body while loading");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await f.settle();
    assert.ok(f.text().includes("second body"));
});

test("logout/account switch removes both log families even with pages unmounted; late responses cannot repopulate", async (t) => {
    const f = fixture(t);
    await f.render();
    const pending = f.defer();
    await f.change(() => f.table.pagination.onChange(2, 20));
    await f.render(false);
    f.client.setQueryData(["admin", "credit-logs", "list", "token-A", "", 1, 10], { items: [summary("credit-old")], total: 1 });
    await f.change(() => f.store.setState({ token: "token-B", user: { id: "B", role: "admin" } }));
    assert.equal(f.client.getQueryCache().getAll().filter((item) => item.queryKey[3] === "token-A").length, 0);
    await f.change(() => pending[0].resolve({ items: [summary("late-A")], total: 1 }));
    assert.equal(f.client.getQueryCache().getAll().filter((item) => item.queryKey[3] === "token-A").length, 0);
    await f.render();
    assert.ok(!f.table.dataSource.some((item) => item.id === "late-A" || item.id === "page-1"));
    await f.change(() => f.store.getState().clearSession());
    assert.equal(f.table.dataSource.length, 0);
    assert.equal(f.client.getQueryCache().getAll().filter((item) => item.queryKey[3] === "token-B").length, 0);
});

test("a mounted account switch never paints the previous identity while the new request is pending", async (t) => {
    const f = fixture(t);
    await f.render();
    assert.equal(f.table.dataSource[0]?.id, "page-1");
    f.client.setQueryData(["admin", "ai-logs", "detail", "token-A", "old"], { ...summary("old"), requestBody: "old body", responseBody: "", error: "" });
    const pending = f.defer();
    await f.changeWithoutRerender(() => f.store.setState({ token: "token-B", user: { id: "B", role: "admin" } }));
    assert.equal(f.table.dataSource.length, 0, "the first frame after an account switch must not reuse rows from token-A");
    assert.equal(f.client.getQueryCache().getAll().filter((item) => item.queryKey[3] === "token-A").length, 0);
    assert.equal(pending.length, 1);
    await f.changeWithoutRerender(() => pending[0].resolve({ items: [summary("page-B")], total: 1 }));
    assert.equal(f.table.dataSource[0]?.id, "page-B");
    assert.ok(f.client.getQueryCache().getAll().filter((item) => item.queryKey[3] === "token-B").some((item) => item.state.data?.items?.[0]?.id === "page-B"));

    f.respond((config) => config.url.startsWith("/api/admin/ai-logs/")
        ? { ...summary("page-B"), requestBody: "token-B detail", responseBody: "", error: "" }
        : { items: [summary("page-B")], total: 1 });
    const actions = () => f.table.columns.find((column) => column.key === "actions").render(null, f.table.dataSource[0]).props.children;
    await f.change(() => actions()[0].props.onClick());
    await f.settle();
    assert.ok(f.text().includes("token-B detail"), "detail actions must use the current account after an in-place switch");
});

test("login, logout, and token rotation purge both log cache families while their pages are unmounted", async (t) => {
    const f = fixture(t);
    await f.render();
    await f.render(false);
    const seed = () => {
        f.client.setQueryData(["admin", "ai-logs", "list", "stale", "", 1, 20], { items: [summary("ai")], total: 1 });
        f.client.setQueryData(["admin", "ai-logs", "detail", "stale", "ai"], { ...summary("ai"), requestBody: "body", responseBody: "", error: "" });
        f.client.setQueryData(["admin", "credit-logs", "list", "stale", "", 1, 10], { items: [summary("credit")], total: 1 });
    };
    seed();
    await f.change(() => f.store.getState().clearSession());
    await f.render();
    assert.equal(f.client.getQueryCache().getAll().filter((item) => item.queryKey[3] === "stale").length, 0);
    seed();
    await f.change(() => f.store.setState({ token: "token-login", user: { id: "login", role: "admin" } }));
    await f.render();
    assert.equal(f.client.getQueryCache().getAll().filter((item) => item.queryKey[3] === "stale").length, 0);
    assert.ok(f.client.getQueryCache().getAll().some((item) => item.queryKey[3] === "token-login"));
    seed();
    await f.change(() => f.store.setState({ token: "token-rotated", user: { id: "login", role: "admin" } }));
    await f.render();
    assert.equal(f.client.getQueryCache().getAll().filter((item) => item.queryKey[3] === "stale" || item.queryKey[3] === "token-login").length, 0);
    assert.ok(f.client.getQueryCache().getAll().some((item) => item.queryKey[3] === "token-rotated"));
});

test("credit search/reset submits filters on page one without duplicate requests", async (t) => {
    const f = fixture(t, "credit-logs");
    await f.render();
    await f.change(() => f.credit.changePage(3));
    const before = f.logCalls().length;
    await f.change(() => f.credit.searchLogs("needle"));
    assert.deepEqual(f.logCalls().slice(before).map((item) => [item.params.keyword, item.params.page]), [["needle", 1]]);
    await f.change(() => f.credit.resetFilters());
    assert.equal(f.credit.keyword, "");
    assert.equal(f.credit.page, 1);
});

test("AI log cleanup preserves the baseline retention query parameter", async (t) => {
    const requests = [];
    const originalAdapter = axios.defaults.adapter;
    axios.defaults.adapter = async (config) => {
        requests.push(config);
        return { data: { code: 0, data: { removedFiles: 2 }, msg: "" }, status: 200, statusText: "OK", headers: {}, config };
    };
    t.after(() => { axios.defaults.adapter = originalAdapter; });
    const result = await adminApi.deleteAdminAICallLogs("token", 3);
    assert.equal(requests[0].url, "/api/admin/ai-logs?olderThanDays=3");
    assert.equal(result.removedFiles, 2);
});
