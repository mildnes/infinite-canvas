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
    const uploads = [];
    const warnings = [];
    let releaseUpload = () => {};
    const uploadGate = options.gateUpload ? new Promise((resolve) => { releaseUpload = resolve; }) : Promise.resolve();
    const imageStorage = {
        canUseGlobalStorage: (config) => config.mode === "server_sqlite_s3" && Boolean(userStore.getState().user),
        getImageBlob: async () => options.localBlob === false ? null : new Blob(["image"], { type: "image/png" }),
        getProxyUrl: (url) => url,
        loadStorageConfig: async () => ({ mode: "server_sqlite_s3", allowUserProvider: false, allowUserGlobalProvider: true, autoSyncAllAssets: true }),
        loadUserStorageProvider: () => null,
        resolveImageUrl: async (storageKey) => storageKey?.startsWith("server:") ? `/api/files/${storageKey.slice(7)}/content` : "blob:local-preview",
        setImageBlob: async () => "blob:stored-preview",
        uploadImage: async () => {
            uploads.push("image");
            await uploadGate;
            return { storageKey: "server:uploaded", url: "/api/files/uploaded/content", width: 1, height: 1, bytes: 5, mimeType: "image/png" };
        },
        uploadRemoteImageToServer: async () => {
            uploads.push("remote");
            return { storageKey: "server:uploaded", url: "/api/files/uploaded/content", width: 1, height: 1, bytes: 5, mimeType: "image/png" };
        },
    };
    const fileStorage = {
        getMediaBlob: async () => null,
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
                    clearTimeout(timeout);
                    unsubscribe();
                    resolve(value);
                };
                const timeout = setTimeout(() => finish(false), timeoutMs);
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
    return { api: exports, userStore, uploads, warnings, releaseUpload };
}

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
        /const token = get\(\)\.token;[\s\S]*?if \(!token\)[\s\S]*?set\(\{ user: null, isReady: true \}\)[\s\S]*?set\(\{ isLoading: true, isReady: false \}\)/.test(useUserSource),
        "hydrateUser 必须先读取已水合 token，再显式进入加载态",
    );
    assert.ok(
        /if \(!hydrated\) set\(\{ isLoading: false, isReady: true \}\)/.test(useUserSource),
        "persist 水合超时也必须结束就绪等待，避免永久卡住",
    );
    assert.ok(
        /hydrateUser[\s\S]*?set\(\{ isLoading: true, isReady: false \}\)/.test(useUserSource),
        "hydrateUser 开始请求时必须把 isReady 置回 false，避免水合完成后的旧 isReady=true 提前放行",
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
