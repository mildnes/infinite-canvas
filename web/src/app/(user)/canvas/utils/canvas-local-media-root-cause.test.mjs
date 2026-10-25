import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const baseline = process.env.LOCAL_MEDIA_BASELINE;
const loadSource = (relativePath) => baseline
    ? execFileSync("git", ["show", `${baseline}:web/src/${relativePath}`], { cwd: new URL("../../../../../", import.meta.url), encoding: "utf8" })
    : readFileSync(new URL(`../../../../${relativePath}`, import.meta.url), "utf8");
const mediaSource = loadSource("app/(user)/canvas/utils/canvas-media-persistence.ts");
const pageSource = loadSource("app/(user)/canvas/[id]/canvas-client-page.tsx");
const migrationSource = loadSource("services/storage-migration.ts");
const useUserSource = loadSource("stores/use-user-store.ts");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createUserStore(initial) {
    let state = initial;
    const listeners = new Set();
    const store = {
        getState: () => state,
        setState: (patch) => {
            const previous = state;
            state = { ...state, ...patch };
            listeners.forEach((listener) => listener(state, previous));
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return store;
}

function loadMediaModule(options = {}) {
    const userStore = createUserStore(options.user || { token: "A-token", user: null, isReady: false });
    const timers = options.timers || { setTimeout, clearTimeout };
    const uploads = [];
    const warnings = [];
    let releaseUpload = () => {};
    let releaseBlob = () => {};
    let blobReads = 0;
    const uploadTokens = [];
    const uploadGate = options.gateUpload ? new Promise((resolve) => { releaseUpload = resolve; }) : Promise.resolve();
    const blobGate = options.gateBlob ? new Promise((resolve) => { releaseBlob = resolve; }) : Promise.resolve();
    const imageStorage = {
        canUseGlobalStorage: (config) => config.mode === "server_sqlite_s3" && Boolean(userStore.getState().user),
        getImageBlob: async () => {
            blobReads += 1;
            await blobGate;
            return options.localBlob === false ? null : new Blob(["image"], { type: "image/png" });
        },
        getProxyUrl: (url) => url,
        loadStorageConfig: async () => ({ mode: "server_sqlite_s3", allowUserProvider: false, allowUserGlobalProvider: true, autoSyncAllAssets: true }),
        loadUserStorageProvider: () => null,
        resolveImageUrl: async (storageKey) => storageKey?.startsWith("server:") ? `/api/files/${storageKey.slice(7)}/content` : "blob:local-preview",
        setImageBlob: async () => "blob:stored-preview",
        uploadImage: async (_source, uploadOptions = {}) => {
            uploads.push("image");
            uploadTokens.push(uploadOptions.token);
            await uploadGate;
            return { storageKey: "server:uploaded", url: "/api/files/uploaded/content", width: 1, height: 1, bytes: 5, mimeType: "image/png" };
        },
        uploadRemoteImageToServer: async () => {
            uploads.push("remote");
            return { storageKey: "server:uploaded", url: "/api/files/uploaded/content", width: 1, height: 1, bytes: 5, mimeType: "image/png" };
        },
    };
    const fileStorage = {
        getMediaBlob: async () => {
            if (!options.mediaBlob) return null;
            blobReads += 1;
            await blobGate;
            return new Blob(["media"], { type: "video/mp4" });
        },
        resolveMediaUrl: async () => "",
        setMediaBlob: async () => "",
        uploadMediaBlob: async () => {
            uploads.push("media");
            return { storageKey: "server:media", url: "/api/files/media/content", bytes: 5, mimeType: "video/mp4" };
        },
        uploadRemoteMediaToServer: async () => ({ storageKey: "server:media", url: "/api/files/media/content", bytes: 5, mimeType: "video/mp4" }),
    };
    const userModule = {
        useUserStore: userStore,
        waitForUserReadiness: (ready, subscribe, timeoutMs) => {
            if (ready()) return Promise.resolve(true);
            return new Promise((resolve) => {
                let settled = false;
                let unsubscribe = () => {};
                const finish = (value) => {
                    if (settled) return;
                    settled = true;
                    timers.clearTimeout(timeout);
                    unsubscribe();
                    resolve(value);
                };
                const timeout = timers.setTimeout(() => finish(false), timeoutMs);
                unsubscribe = subscribe(() => {
                    if (ready()) finish(true);
                });
            });
        },
    };
    const modules = {
        "@/services/image-storage": imageStorage,
        "@/services/file-storage": fileStorage,
        "@/stores/use-user-store": userModule,
        "../types": { CanvasNodeType: { Video: "video", Audio: "audio" } },
        "./canvas-panorama": { isCanvasImageNodeType: (type) => type === "image" },
    };
    const exports = {};
    const context = {
        exports,
        require: (name) => modules[name] || {},
        Blob,
        URL,
        Map,
        Set,
        Promise,
        Error,
        console: {
            ...console,
            warn: (...args) => warnings.push(args),
        },
        window: { location: { origin: "https://canvas.example" } },
        fetch: async () => ({ ok: true, blob: async () => new Blob(["image"], { type: "image/png" }) }),
        setTimeout,
        clearTimeout,
    };
    vm.runInNewContext(
        ts.transpileModule(mediaSource, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        }).outputText,
        context,
    );
    return { api: exports, userStore, uploads, warnings, releaseUpload, releaseBlob, uploadTokens, blobReads: () => blobReads };
}

function createReadinessClock() {
    let now = 0;
    let scheduled = 0;
    const timers = new Map();
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    return {
        timers: {
            setTimeout(callback, timeoutMs) {
                const id = ++scheduled;
                timers.set(id, { at: now + timeoutMs, callback });
                return id;
            },
            clearTimeout: (id) => timers.delete(id),
        },
        elapsed: () => now,
        scheduled: () => scheduled,
        flush,
        async finish(pending) {
            let settled = false;
            let result;
            let failure;
            pending.then((value) => { result = value; settled = true; }, (error) => { failure = error; settled = true; });
            for (let step = 0; step < 50; step += 1) {
                await flush();
                if (settled) {
                    if (failure) throw failure;
                    return result;
                }
                assert.ok(timers.size, "repair 未结束却没有待触发的就绪计时器");
                now = Math.min(...Array.from(timers.values(), (timer) => timer.at));
                for (const [id, timer] of timers) {
                    if (timer.at > now) continue;
                    timers.delete(id);
                    timer.callback();
                }
            }
            assert.fail("repair 超过虚拟时钟推进上限");
        },
    };
}

const localOnlyNodes = () => Array.from({ length: 6 }, (_, index) => ({
    id: `local-${index}`,
    type: "image",
    metadata: { storageKey: `image:local-${index}`, content: "blob:local-preview", mediaStatus: "local-only" },
}));

const localOnlySessions = () => [{
    id: "session",
    messages: [{
        id: "message",
        images: [{ id: "assistant-image", dataUrl: "blob:local-preview", storageKey: "image:assistant-image" }],
        references: [{ id: "assistant-ref", dataUrl: "blob:local-preview", storageKey: "image:assistant-ref" }],
    }],
}];

test("六个 local-only 节点的一次 repair 仅等待一次超时并保留重试原因", async () => {
    const clock = createReadinessClock();
    const f = loadMediaModule({ timers: clock.timers });
    const nodes = localOnlyNodes();
    const result = await clock.finish(f.api.repairCanvasNodesMedia(nodes, { allowUpload: true, cloudWaitMs: 10_000 }));
    assert.equal(clock.elapsed(), 10_000, "六个引用应共用一次 10000ms 等待");
    assert.equal(clock.scheduled(), 1, "一次节点 repair 只能创建一个就绪等待");
    assert.equal(f.uploads.length, 0);
    for (const [index, node] of result.nodes.entries()) {
        assert.equal(node.metadata.storageKey, nodes[index].metadata.storageKey);
        assert.equal(node.metadata.mediaStatus, "local-only");
        assert.equal(node.metadata.mediaError, "登录态未就绪，稍后自动重试");
    }
    f.userStore.setState({ user: { id: "A" }, isReady: true });
    const retried = await clock.finish(f.api.repairCanvasNodesMedia(result.nodes, { allowUpload: true, cloudWaitMs: 10_000 }));
    assert.equal(retried.uploaded, 6, "下一轮 repair 必须重新判定，不能缓存上一轮的超时结果");
    assert.equal(clock.scheduled(), 1);
});

test("project 的节点和助手媒体共用同一次就绪超时", async () => {
    const clock = createReadinessClock();
    const f = loadMediaModule({ timers: clock.timers });
    const result = await clock.finish(f.api.repairCanvasProjectMedia(localOnlyNodes(), localOnlySessions(), { allowUpload: true, cloudWaitMs: 10_000 }));
    assert.equal(clock.elapsed(), 10_000, "节点与助手引用不能分阶段累积等待");
    assert.equal(clock.scheduled(), 1);
    assert.equal(result.uploaded, 0);
    assert.equal(result.sessions[0].messages[0].images[0].storageKey, "image:assistant-image");
    assert.equal(result.sessions[0].messages[0].references[0].storageKey, "image:assistant-ref");
});

test("已有本地预览的节点在就绪超时后也写回可区分的重试原因", async () => {
    const clock = createReadinessClock();
    const f = loadMediaModule({ timers: clock.timers });
    const result = await clock.finish(f.api.repairCanvasProjectMedia(localOnlyNodes().slice(0, 1), [], { allowUpload: true, cloudWaitMs: 10_000 }));
    assert.equal(result.nodes[0].metadata.mediaStatus, "local-only");
    assert.equal(result.nodes[0].metadata.mediaError, "登录态未就绪，稍后自动重试");
    assert.equal(result.changed, true, "仅超时原因改变时也必须回写节点");
});

test("共享等待期间登录就绪后所有节点和助手媒体仍成功上传", async () => {
    const clock = createReadinessClock();
    const f = loadMediaModule({ timers: clock.timers });
    const pending = f.api.repairCanvasProjectMedia(localOnlyNodes(), localOnlySessions(), { allowUpload: true, cloudWaitMs: 10_000 });
    await clock.flush();
    const scheduledBeforeReady = clock.scheduled();
    assert.equal(f.uploads.length, 0, "尚未就绪不能提前上传");
    f.userStore.setState({ user: { id: "A" }, isReady: true });
    const result = await clock.finish(pending);
    assert.equal(scheduledBeforeReady, 1, "多个引用必须订阅同一次就绪等待");
    assert.equal(clock.elapsed(), 0, "就绪事件应结束等待，无需等到超时");
    assert.equal(result.uploaded, 8);
    assert.equal(f.uploads.length, 8);
    assert.ok(f.uploadTokens.every((token) => token === "A-token"));
    assert.ok(result.nodes.every((node) => node.metadata.storageKey === "server:uploaded" && node.metadata.mediaStatus === "ok"));
    assert.equal(result.sessions[0].messages[0].images[0].storageKey, "server:uploaded");
    assert.equal(result.sessions[0].messages[0].references[0].storageKey, "server:uploaded");
});

test("共享就绪等待期间切号不上传也不返回旧账号的改写", async () => {
    const clock = createReadinessClock();
    const f = loadMediaModule({ timers: clock.timers });
    const nodes = localOnlyNodes();
    const sessions = localOnlySessions();
    const pending = f.api.repairCanvasProjectMedia(nodes, sessions, { allowUpload: true, cloudWaitMs: 10_000 });
    await clock.flush();
    f.userStore.setState({ token: "B-token", user: { id: "B" }, isReady: true });
    const result = await clock.finish(pending);
    assert.equal(f.uploads.length, 0);
    assert.equal(result.changed, false);
    assert.equal(result.nodes, nodes);
    assert.equal(result.sessions, sessions);
});

test("禁止上传的 repair 不等待就绪并保留本地引用", async () => {
    const clock = createReadinessClock();
    const f = loadMediaModule({ timers: clock.timers });
    const result = await clock.finish(f.api.repairCanvasProjectMedia(localOnlyNodes(), localOnlySessions(), { allowUpload: false, cloudWaitMs: 10_000 }));
    assert.equal(clock.elapsed(), 0);
    assert.equal(clock.scheduled(), 0);
    assert.equal(f.uploads.length, 0);
    assert.ok(result.nodes.every((node) => node.metadata.mediaStatus === "local-only"));
});

test("没有媒体引用的画板不额外等待登录就绪", async () => {
    const clock = createReadinessClock();
    const f = loadMediaModule({ timers: clock.timers });
    const nodes = [{ id: "text", type: "text", metadata: { content: "只含文字" } }];
    const result = await clock.finish(f.api.repairCanvasProjectMedia(nodes, [], { allowUpload: true, cloudWaitMs: 10_000 }));
    assert.equal(clock.elapsed(), 0);
    assert.equal(clock.scheduled(), 0);
    assert.equal(result.nodes[0], nodes[0]);
    assert.equal(result.changed, false);
});

function runBackgroundRepair(f, { nodes, sessions = [], loadedToken = "A-token" }) {
    const start = pageSource.indexOf("    useEffect(() => {\n        if (!projectLoaded || !userReady");
    assert.ok(start >= 0, "用户就绪补跑 effect 应存在");
    const end = pageSource.indexOf("\n\n    useEffect", start);
    const state = { nodes, sessions };
    const context = {
        ...f.api,
        useEffect: (effect) => effect(),
        projectLoaded: true, userReady: true, currentAccountId: "A", currentUserToken: "A-token",
        projectId: "board", activeProjectIdRef: { current: "board" },
        loadedProjectRef: { current: { id: "board", ownerId: loadedToken === "A-token" ? "A" : "B" } },
        nodesRef: { current: nodes }, latestCanvasStateRef: { current: { chatSessions: sessions } },
        useUserStore: f.userStore, message: { success() {}, warning() {} },
        currentCanvasOwnerId: () => f.userStore.getState().user?.id || "anonymous",
        setNodes: (next) => { state.nodes = typeof next === "function" ? next(state.nodes) : next; },
        setChatSessions: (next) => { state.sessions = typeof next === "function" ? next(state.sessions) : next; },
        syncAssistantReferences: (next) => next,
    };
    vm.runInNewContext(ts.transpileModule(pageSource.slice(start, end), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, context);
    return { state, context };
}

test("读取本地 blob 期间切号不上传 A 的媒体，也不返回云端改写", async () => {
    const f = loadMediaModule({ user: { token: "A-token", user: { id: "A" }, isReady: true }, gateBlob: true });
    const node = { id: "local", type: "image", metadata: { storageKey: "image:private-A", content: "blob:local", mediaStatus: "local-only" } };
    const pending = f.api.repairCanvasProjectMedia([node], [], { allowUpload: true });
    while (!f.blobReads()) await delay(1);
    f.userStore.setState({ token: "B-token", user: { id: "B" }, isReady: true });
    f.releaseBlob();
    const result = await pending;
    assert.equal(f.uploads.length, 0, "A repair 在 IndexedDB 返回后必须取消，不能借用 B token 上传");
    assert.equal(result.nodes[0].metadata.storageKey, "image:private-A");
});

test("repair 上传明确绑定启动账号，迟到响应不改写节点", async () => {
    const f = loadMediaModule({ user: { token: "A-token", user: { id: "A" }, isReady: true }, gateUpload: true });
    const node = { id: "local", type: "image", metadata: { storageKey: "image:A", content: "blob:local", mediaStatus: "local-only" } };
    const pending = f.api.repairCanvasProjectMedia([node], [], { allowUpload: true });
    while (!f.uploads.length) await delay(1);
    assert.equal(f.uploadTokens[0], "A-token");
    f.userStore.setState({ token: "B-token", user: { id: "B" }, isReady: true });
    f.releaseUpload();
    const result = await pending;
    assert.equal(result.nodes[0].metadata.storageKey, "image:A", "切号后的迟到上传结果必须丢弃");
});

test("视频本地 blob 读取期间切号也停止媒体上传", async () => {
    const f = loadMediaModule({ user: { token: "A-token", user: { id: "A" }, isReady: true }, gateBlob: true, mediaBlob: true });
    const node = { id: "video", type: "video", metadata: { storageKey: "file:private-A", mediaStatus: "local-only" } };
    const pending = f.api.repairCanvasProjectMedia([node], [], { allowUpload: true });
    while (!f.blobReads()) await delay(1);
    f.userStore.setState({ token: "B-token", user: { id: "B" }, isReady: true });
    f.releaseBlob();
    const result = await pending;
    assert.equal(f.uploads.length, 0);
    assert.equal(result.nodes[0].metadata.storageKey, "file:private-A");
});

test("当前已加载画板仍属于旧 token 时，不启动新账号后台 repair", async () => {
    const f = loadMediaModule({ user: { token: "A-token", user: { id: "A" }, isReady: true } });
    runBackgroundRepair(f, { loadedToken: "previous-token", nodes: [
        { id: "local", type: "image", metadata: { storageKey: "image:previous", mediaStatus: "local-only" } },
    ] });
    await delay(30);
    assert.equal(f.uploads.length, 0);
});

test("后台 repair 等待期间增删移动节点、改内容和聊天均保留", async () => {
    const f = loadMediaModule({ user: { token: "A-token", user: { id: "A" }, isReady: true }, gateUpload: true });
    const nodes = ["moved", "edited", "deleted"].map((id) => ({
        id, type: "image", x: 0, metadata: { content: "blob:local", storageKey: `image:${id}`, mediaStatus: "local-only", prompt: "old" },
    }));
    const sessions = [{ id: "session", title: "old", messages: [
        { id: "message", text: "old", images: [{ id: "image", dataUrl: "blob:local", storageKey: "image:moved" }] },
    ] }];
    const fEffect = runBackgroundRepair(f, { nodes, sessions });
    while (!f.uploads.length) await delay(1);
    const latest = [
        { ...nodes[0], x: 150, metadata: { ...nodes[0].metadata, prompt: "new prompt" } },
        { ...nodes[1], metadata: { ...nodes[1].metadata, content: "/api/files/user-edit/content", storageKey: "server:user-edit" } },
        { id: "new", type: "text", metadata: { content: "new node" } },
    ];
    fEffect.state.nodes = latest;
    fEffect.context.nodesRef.current = latest;
    fEffect.state.sessions = [{ ...sessions[0], title: "new title", messages: [
        { ...sessions[0].messages[0], text: "edited chat" }, { id: "new-message", text: "new chat" },
    ] }];
    f.releaseUpload();
    await delay(40);
    assert.deepEqual(fEffect.state.nodes.map((n) => n.id), ["moved", "edited", "new"]);
    assert.equal(fEffect.state.nodes[0].x, 150);
    assert.equal(fEffect.state.nodes[0].metadata.prompt, "new prompt");
    assert.equal(fEffect.state.nodes[0].metadata.storageKey, "server:uploaded");
    assert.equal(fEffect.state.nodes[1].metadata.storageKey, "server:user-edit");
    assert.equal(fEffect.state.sessions[0].title, "new title");
    assert.equal(fEffect.state.sessions[0].messages[0].text, "edited chat");
    assert.equal(fEffect.state.sessions[0].messages[1].text, "new chat");
    assert.equal(fEffect.state.sessions[0].messages[0].images[0].storageKey, "server:uploaded");
});

test("登录态未就绪时，可上传判定会等待用户就绪而不是立即返回 false", async () => {
    const f = loadMediaModule();
    let settled = false;
    const decision = f.api.canUploadCanvasMediaToServer(500).then((value) => {
        settled = true;
        return value;
    });
    await delay(30);
    assert.equal(settled, false, "user 拉取期间不应立即判为不可上传");
    f.userStore.setState({ isReady: true, user: { id: "A", role: "admin" } });
    assert.equal(await decision, true);
});

test("用户 store 在 token 水合后显式从 isReady=false 进入就绪，并在失败时也结束等待", () => {
    assert.ok(
        /const token = get\(\)\.token;[\s\S]*?if \(!token\)[\s\S]*?set\(\{ user: null, isReady: true \}\)[\s\S]*?const knownUser = get\(\)\.user;[\s\S]*?set\(knownUser \? \{ isLoading: true \} : \{ isLoading: true, isReady: false \}\)/.test(useUserSource),
        "hydrateUser 必须先读取已水合 token，再显式进入加载态",
    );
    assert.ok(
        /if \(!hydrated\) set\(\{ isLoading: false, isReady: true \}\)/.test(useUserSource),
        "persist 水合超时也必须结束就绪等待，避免永久卡住",
    );
    assert.ok(
        /const knownUser = get\(\)\.user;[\s\S]*?set\(knownUser \? \{ isLoading: true \} : \{ isLoading: true, isReady: false \}\)/.test(useUserSource),
        "hydrateUser 仅在首次水合时把 isReady 置回 false，刷新已知用户时保持 owner 稳定",
    );
});

test("早到的 hydrateUser 等水合拿到 token 后继续，而不是把账号永久判成 anonymous", () => {
    assert.ok(
        /waitForUserReadiness\(\s*\(\)\s*=>\s*useUserStore\.persist\.hasHydrated\(\)/.test(useUserSource),
        "hydrateUser 应在登录组件挂载前等待 persist 水合完成",
    );
    assert.ok(
        /const token = get\(\)\.token;[\s\S]*?if \(!token\)[\s\S]*?set\(\{ user: null, isReady: true \}\)/.test(useUserSource),
        "拿到 token 后应继续请求当前用户，不能提前结束为匿名",
    );
});

test("等待超时保留 local-only，并写入稍后自动重试原因", async () => {
    const f = loadMediaModule();
    const result = await f.api.repairCanvasMediaRef(
        { content: "blob:local-preview", storageKey: "image:local", mediaStatus: "local-only" },
        "image",
        { allowUpload: true, cloudWaitMs: 25 },
    );
    assert.equal(result.ref.storageKey, "image:local");
    assert.equal(result.ref.mediaStatus, "local-only");
    assert.match(result.ref.mediaError, /稍后自动重试/);
});

test("同一本地 storageKey 的并发 repair 只上传一次", async () => {
    const f = loadMediaModule({
        user: { token: "A-token", user: { id: "A", role: "admin" }, isReady: true },
        gateUpload: true,
    });
    const node = { id: "node", type: "image", metadata: { content: "blob:local-preview", storageKey: "image:local", mediaStatus: "local-only" } };
    const first = f.api.repairCanvasProjectMedia([node], [], { allowUpload: true });
    const second = f.api.repairCanvasProjectMedia([node], [], { allowUpload: true });
    for (let i = 0; i < 20 && f.uploads.length === 0; i += 1) await delay(1);
    await delay(20);
    const observedUploads = f.uploads.length;
    f.releaseUpload();
    await Promise.all([first, second]);
    assert.equal(observedUploads, 1, "并发 repair 必须复用同一个在途上传");
});

test("不同账号的同一本地 storageKey 不共用在途 repair", async () => {
    const f = loadMediaModule({
        user: { token: "A-token", user: { id: "A", role: "admin" }, isReady: true },
        gateUpload: true,
    });
    const node = { id: "node", type: "image", metadata: { content: "blob:local-preview", storageKey: "image:local", mediaStatus: "local-only" } };
    const first = f.api.repairCanvasProjectMedia([node], [], { allowUpload: true });
    for (let i = 0; i < 20 && f.uploads.length === 0; i += 1) await delay(1);
    assert.equal(f.uploads.length, 1);

    f.userStore.setState({ token: "B-token", user: { id: "B", role: "admin" }, isReady: true });
    const second = f.api.repairCanvasProjectMedia([node], [], { allowUpload: true });
    for (let i = 0; i < 20 && f.uploads.length < 2; i += 1) await delay(1);
    const observedUploads = f.uploads.length;
    f.releaseUpload();
    await Promise.all([first, second]);
    assert.equal(observedUploads, 2, "账号切换后不得复用上一账号的在途上传");
});

test("登录态从等待转为就绪时，同一 token 的在途 repair 仍然只上传一次", async () => {
    const f = loadMediaModule({ gateUpload: true });
    const node = { id: "node", type: "image", metadata: { content: "blob:local-preview", storageKey: "image:local", mediaStatus: "local-only" } };
    const first = f.api.repairCanvasProjectMedia([node], [], { allowUpload: true });
    await delay(5);
    f.userStore.setState({ user: { id: "A", role: "admin" }, isReady: true });
    for (let i = 0; i < 20 && f.uploads.length === 0; i += 1) await delay(1);
    assert.equal(f.uploads.length, 1);

    const second = f.api.repairCanvasProjectMedia([node], [], { allowUpload: true });
    for (let i = 0; i < 20; i += 1) await delay(1);
    const observedUploads = f.uploads.length;
    f.releaseUpload();
    await Promise.all([first, second]);
    assert.equal(observedUploads, 1, "登录就绪前后必须复用同一 token 的在途上传");
});

test("同 token 就绪后补跑只读取最新节点，不把首次 repair 前的旧内容再上传一次", async () => {
    const f = loadMediaModule({
        user: { token: "A-token", user: { id: "A", role: "admin" }, isReady: true },
        gateUpload: true,
    });
    const node = { id: "node", type: "image", metadata: { content: "blob:local-preview", storageKey: "image:local", mediaStatus: "local-only" } };
    const first = f.api.repairCanvasProjectMedia([node], [], { allowUpload: true });
    for (let i = 0; i < 20 && f.uploads.length === 0; i += 1) await delay(1);
    assert.equal(f.uploads.length, 1);
    f.releaseUpload();
    const uploaded = await first;
    assert.equal(uploaded.uploaded, 1);

    const second = f.api.repairCanvasProjectMedia(uploaded.nodes, [], { allowUpload: true });
    const secondResult = await second;
    assert.equal(f.uploads.length, 1, "已改写的 server 引用不应再次上传");
    assert.equal(secondResult.uploaded, 0);
});

test("共享 repair 结果只在短窗口内复用，不会永久驻留", () => {
    assert.ok(!/Number\.POSITIVE_INFINITY/.test(mediaSource), "成功 repair 不应使用无限期缓存");
    assert.ok(/SHARED_MEDIA_REPAIR_TTL_MS/.test(mediaSource), "共享 repair 应显式设置缓存有效期");
    assert.ok(/expiresAt\s*<=\s*Date\.now\(\)/.test(mediaSource), "读取缓存时应惰性清理过期项");
});

test("local-only 汇总包含 ownerId、nodeId、bytes 和 reason", () => {
    const f = loadMediaModule();
    assert.equal(typeof f.api.reportCanvasLocalOnlyMedia, "function");
    f.api.reportCanvasLocalOnlyMedia([
        { id: "kept", type: "image", metadata: { storageKey: "server:ok", mediaStatus: "ok" } },
        { id: "local", type: "image", metadata: { storageKey: "image:local", mediaStatus: "local-only", mediaError: "登录态未就绪，稍后自动重试", bytes: 4653937 } },
    ], "mildnes");
    assert.equal(f.warnings.length, 1);
    const report = f.warnings[0][1];
    assert.equal(report.ownerId, "mildnes");
    assert.deepEqual(
        {
            nodeId: report.nodes[0].nodeId,
            bytes: report.nodes[0].bytes,
            reason: report.nodes[0].reason,
        },
        { nodeId: "local", bytes: 4653937, reason: "登录态未就绪，稍后自动重试" },
    );
});

test("画布在用户就绪后补跑 repair，并保留账号切换守卫", () => {
    assert.ok(/state\.isReady/.test(pageSource), "画布应等待用户 store 就绪");
    assert.ok(/mediaStatus === "local-only"/.test(pageSource), "画布应只补跑本地媒体");
    assert.ok(/repairCanvasProjectMedia\([\s\S]*?\{ allowUpload: true \}/.test(pageSource), "用户就绪后应触发自动补传");
    assert.ok(/reportCanvasLocalOnlyMedia/.test(pageSource), "repair 后应汇总仍在本地的媒体");
    assert.ok(/ownerToken[\s\S]*?ownerUserId[\s\S]*?isCurrent/.test(pageSource), "旧账号 repair 结果不得回写");
});

test("死代码 migrateLocalAssetsToCloud 已移除并说明统一补传入口", () => {
    assert.ok(!/export async function migrateLocalAssetsToCloud/.test(migrationSource), "未接线的整库迁移入口应删除");
    assert.ok(/repairCanvasProjectMedia/.test(migrationSource), "原位置应说明统一补传入口");
});
