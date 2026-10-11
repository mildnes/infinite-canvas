import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { useConfigStore } from "./use-config-store.ts";
import { useUserStore } from "./use-user-store.ts";

test("公开设置携带 token，切号立即清空且新请求不被旧 loading 阻塞，丢弃迟到结果", async () => {
    const original = axios.request;
    const requests = [];
    axios.request = config => new Promise(resolve => requests.push({ config, resolve }));
    try {
        useUserStore.setState({ token: "a", user: { id: "a", role: "user" } });
        useConfigStore.setState({ publicSettings: { modelChannel: { availableModels: ["previous"] } }, isPublicSettingsLoading: false });
        const first = useConfigStore.getState().loadPublicSettings();
        assert.equal(requests[0].config.headers?.Authorization, "Bearer a");
        useUserStore.setState({ token: "b", user: { id: "b", role: "user" } });
        assert.equal(useConfigStore.getState().publicSettings, null);
        const second = useConfigStore.getState().loadPublicSettings();
        assert.equal(requests.length, 2);
        requests[1].resolve({ status: 200, data: { code: 0, data: { modelChannel: { availableModels: ["b-model"] } } } });
        await second;
        requests[0].resolve({ status: 200, data: { code: 0, data: { modelChannel: { availableModels: ["a-model"] } } } });
        await first;
        assert.deepEqual(useConfigStore.getState().publicSettings.modelChannel.availableModels, ["b-model"]);
        useUserStore.setState({ token: "", user: null });
        assert.equal(useConfigStore.getState().publicSettings, null);
        const guest = useConfigStore.getState().loadPublicSettings();
        assert.equal(requests[2].config.headers, undefined);
        requests[2].resolve({ status: 200, data: { code: 0, data: { modelChannel: { availableModels: ["guest"] } } } });
        await guest;
    } finally { axios.request = original; useUserStore.setState({ token: "", user: null }); }
});

test("同账号请求去重，A→B→A 仍丢弃首次 A 的结果与失败，不干扰当前 loading", async () => {
    const original = axios.request;
    const requests = [];
    axios.request = config => new Promise((resolve, reject) => requests.push({ config, resolve, reject }));
    try {
        useUserStore.setState({ token: "a", user: { id: "a" } });
        const stale = useConfigStore.getState().loadPublicSettings();
        const staleRejected = assert.rejects(stale, /接口连接失败/);
        assert.equal(useConfigStore.getState().loadPublicSettings(), stale);
        useUserStore.setState({ token: "b", user: { id: "b" } });
        const other = useConfigStore.getState().loadPublicSettings();
        useUserStore.setState({ token: "a", user: { id: "a" } });
        const current = useConfigStore.getState().loadPublicSettings();
        assert.equal(requests.length, 3);
        requests[0].reject(new Error("old request"));
        await staleRejected;
        requests[1].resolve({ status: 200, data: { code: 0, data: { modelChannel: { availableModels: ["b"] } } } });
        await other;
        assert.equal(useConfigStore.getState().publicSettings, null);
        assert.equal(useConfigStore.getState().isPublicSettingsLoading, true);
        requests[2].resolve({ status: 200, data: { code: 0, data: { modelChannel: { availableModels: ["current-a"] } } } });
        await current;
        assert.deepEqual(useConfigStore.getState().publicSettings.modelChannel.availableModels, ["current-a"]);
        assert.equal(useConfigStore.getState().isPublicSettingsLoading, false);
    } finally { axios.request = original; useUserStore.setState({ token: "", user: null }); }
});
