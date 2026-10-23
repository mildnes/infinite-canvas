import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

function load(path, modules, context = {}) {
    const exports = {};
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    vm.runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        }).outputText,
        {
            exports,
            require: (name) => modules[name] || {},
            Promise,
            console,
            setTimeout,
            clearTimeout,
            window: {},
            ...context,
        },
    );
    return exports;
}

function fixture() {
    let pending;
    const userModule = load("./use-user-store.ts", {
        zustand: require("zustand"),
        "zustand/middleware": { persist: (initializer) => initializer },
        "@/services/api/auth": {
            AUTH_TOKEN_KEY: "infinite-canvas-auth-token-v1",
            fetchCurrentUser: () => new Promise((resolve, reject) => { pending = { resolve, reject }; }),
            login: async () => {},
            register: async () => {},
        },
    });
    const { useUserStore } = userModule;
    useUserStore.persist = {
        hasHydrated: () => true,
        onFinishHydration: () => () => {},
    };
    const storage = load("../lib/localforage-storage.ts", {
        localforage: {
            default: {
                config: () => {},
                getItem: async () => null,
                setItem: async () => {},
                removeItem: async () => {},
            },
        },
        "@/stores/use-user-store": { useUserStore },
    });
    return {
        useUserStore,
        currentStorageOwnerId: storage.currentStorageOwnerId,
        resolve: (user) => pending.resolve(user),
        reject: (error) => pending.reject(error),
        hasRequest: () => Boolean(pending),
    };
}

test("hydrateUser refreshing a known user keeps owner stable while isLoading", async () => {
    const f = fixture();
    f.useUserStore.setState({
        token: "A-token",
        user: { id: "A", role: "admin" },
        isReady: true,
        isLoading: false,
    });

    const hydrating = f.useUserStore.getState().hydrateUser();
    await tick();

    assert.equal(f.currentStorageOwnerId(), "A", "the canvas owner must remain A during a same-account refresh");
    assert.equal(f.useUserStore.getState().isLoading, true);
    assert.equal(f.useUserStore.getState().isReady, true, "a known user refresh must not mark the owner as not ready");

    f.resolve({ id: "A", role: "admin" });
    await hydrating;
    assert.equal(f.useUserStore.getState().isReady, true);
    assert.equal(f.currentStorageOwnerId(), "A");
});

test("first hydration with a token still waits as not ready before establishing the owner", async () => {
    const f = fixture();
    f.useUserStore.setState({
        token: "A-token",
        user: null,
        isReady: true,
        isLoading: false,
    });

    const hydrating = f.useUserStore.getState().hydrateUser();
    await tick();

    assert.equal(f.useUserStore.getState().isLoading, true);
    assert.equal(f.useUserStore.getState().isReady, false, "first hydration must wait for the account result");
    assert.equal(f.currentStorageOwnerId(), null);

    f.resolve({ id: "A", role: "admin" });
    await hydrating;
    assert.equal(f.useUserStore.getState().isReady, true);
    assert.equal(f.currentStorageOwnerId(), "A");
});
