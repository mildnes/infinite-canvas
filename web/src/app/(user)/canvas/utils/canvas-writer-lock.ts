// A small expiring lease, never canvas data. Storage is the authority; the channel
// only wakes peers early. Every write rechecks the lease (including queued saves).
const HEARTBEAT_MS = 3_000;
const LEASE_MS = 10_000;
const TAB_KEY = "infinite-canvas:writer-tab";
const SIGNAL_KEY = "infinite-canvas:writer-signal";
const instanceId = crypto.randomUUID();
let tabId: string | undefined;

export type CanvasWriterStatus = "pending" | "writer" | "reader" | "uncoordinated";
type Lease = { tabId: string; instanceId: string; at: number };
type Signal = { scope: string; type: "changed" | "hello" | "duplicate"; tabId: string; instanceId: string; target?: string };
export type CanvasWriterLock = ReturnType<typeof createCanvasWriterLock>;
const locks = new Map<string, CanvasWriterLock>();
const scopeKey = (owner: string, project: string) => `infinite-canvas:writer:${JSON.stringify([owner === "anon" ? "anonymous" : owner, project])}`;

export function canvasWriterTabId() {
    if (tabId) return tabId;
    try { tabId = window.sessionStorage.getItem(TAB_KEY) || undefined; } catch { /* memory-only identity */ }
    if (!tabId) tabId = crypto.randomUUID();
    try { window.sessionStorage.setItem(TAB_KEY, tabId); } catch { /* storage may be disabled */ }
    return tabId;
}

function readLease(scope: string): Lease | null {
    const raw = window.localStorage.getItem(scope);
    if (!raw) return null;
    try {
        const lease = JSON.parse(raw) as Lease;
        return typeof lease.tabId === "string" && typeof lease.instanceId === "string"
            && Number.isFinite(lease.at) && lease.at <= Date.now() && Date.now() - lease.at < LEASE_MS ? lease : null;
    } catch { return null; }
}

export function hasCanvasWriteAccess(owner: string, project: string): boolean {
    if (typeof window === "undefined") return true;
    const scope = scopeKey(owner, project);
    const lock = locks.get(scope);
    if (lock) return lock.canWrite();
    try {
        const lease = readLease(scope);
        return !lease || lease.instanceId === instanceId;
    } catch { return true; } // Coordination failure must not permanently lock a board.
}

export function createCanvasWriterLock(owner: string, project: string, onChange: (status: CanvasWriterStatus) => void, beforeRelease?: () => void | Promise<void>) {
    const scope = scopeKey(owner, project);
    canvasWriterTabId();
    let status: CanvasWriterStatus = "pending";
    let disposed = false, suspended = false, ready = true, leaving = false, disposeRequested = false;
    let channel: BroadcastChannel | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseGeneration = 0;
    let lastHeartbeat = 0;
    const publishStatus = (next: CanvasWriterStatus) => {
        if (status === next || disposed) return;
        status = next;
        onChange(next);
    };
    const failOpen = (error: unknown) => {
        if (status !== "uncoordinated") console.warn("[canvas-writer-lock] 多窗口保护暂不可用", error);
        publishStatus("uncoordinated");
    };
    const closeChannel = () => {
        try { channel?.close(); } catch { /* storage still coordinates peers */ }
        channel = null;
    };
    const signal = (type: Signal["type"], target?: string) => {
        const data: Signal = { scope, type, tabId: canvasWriterTabId(), instanceId, target };
        if (channel) {
            try { channel.postMessage(data); return; }
            catch { closeChannel(); }
        }
        // Different values even for repeated heartbeats, so storage always emits.
        window.localStorage.setItem(SIGNAL_KEY, JSON.stringify({ ...data, nonce: crypto.randomUUID() }));
    };
    const owns = (lease: Lease | null) => lease?.instanceId === instanceId;
    const claim = () => {
        window.localStorage.setItem(scope, JSON.stringify({ tabId: canvasWriterTabId(), instanceId, at: Date.now() }));
        lastHeartbeat = Date.now();
        signal("changed");
        clearTimeout(settleTimer);
        // Let simultaneous openers observe the winning lease before enabling UI.
        settleTimer = setTimeout(() => {
            try { publishStatus(owns(readLease(scope)) ? "writer" : "reader"); }
            catch (error) { failOpen(error); }
        }, 120);
    };
    const inspect = () => {
        if (disposed || suspended || leaving) return;
        try {
            const lease = readLease(scope);
            if (!lease) { claim(); return; }
            if (!owns(lease)) {
                clearTimeout(settleTimer);
                publishStatus("reader");
                return;
            }
            if (status === "uncoordinated") publishStatus("writer");
            if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
                window.localStorage.setItem(scope, JSON.stringify({ ...lease, at: Date.now() }));
                lastHeartbeat = Date.now();
                signal("changed");
            }
        } catch (error) { failOpen(error); }
    };
    const receive = (data: Signal) => {
        if (!data || (data.type === "changed" && data.scope !== scope) || data.instanceId === instanceId || disposed || suspended) return;
        try {
            // Browsers may clone sessionStorage when duplicating a tab. Keep the
            // established tab's ID and assign a fresh one to the newcomer.
            if (data.type === "hello" && data.tabId === canvasWriterTabId()) signal("duplicate", data.instanceId);
            if (data.type === "duplicate" && data.target === instanceId) {
                tabId = crypto.randomUUID();
                try { window.sessionStorage.setItem(TAB_KEY, tabId); } catch { /* memory-only */ }
            }
            inspect();
        } catch (error) { failOpen(error); }
    };
    const storage = (event: StorageEvent) => {
        if (event.key === scope || event.key === null) inspect();
        if (event.key === SIGNAL_KEY && event.newValue) {
            try { receive(JSON.parse(event.newValue)); } catch { /* ignore unrelated/malformed messages */ }
        }
    };
    const release = () => {
        clearTimeout(settleTimer);
        try {
            if (locks.get(scope) === lock && owns(readLease(scope))) { window.localStorage.removeItem(scope); signal("changed"); }
        } catch (error) { console.warn("[canvas-writer-lock] 释放失败，将按心跳过期", error); }
    };
    const hide = () => {
        if (disposed || leaving) return;
        leaving = true;
        const generation = ++releaseGeneration;
        const finish = () => {
            if (generation !== releaseGeneration) return;
            ++releaseGeneration;
            clearTimeout(releaseTimer);
            suspended = true;
            release();
            publishStatus("pending");
            if (disposeRequested) {
                disposed = true;
                if (locks.get(scope) === lock) locks.delete(scope);
            }
        };
        const failed = (error: unknown) => { console.warn("[canvas-writer-lock] 离开前保存失败，仍释放编辑权", error); finish(); };
        try {
            const saved = beforeRelease?.();
            // Keep the existing final flush writable until it completes. Heartbeats
            // stop immediately, so a stuck request cannot hold the lease forever.
            if (saved) {
                releaseTimer = setTimeout(finish, LEASE_MS);
                Promise.resolve(saved).then(finish, failed);
            } else finish();
        } catch (error) { failed(error); }
    };
    const show = () => { ++releaseGeneration; clearTimeout(releaseTimer); leaving = false; suspended = false; inspect(); };
    const lock = {
        canWrite() {
            if (disposed || suspended || !ready || status === "pending" || status === "reader") return false;
            try {
                if (status === "uncoordinated") return true;
                if (owns(readLease(scope))) return true;
                inspect();
                return false;
            } catch (error) { failOpen(error); return true; }
        },
        takeOver() {
            if (disposed || suspended) return;
            try { publishStatus("pending"); claim(); } catch (error) { failOpen(error); }
        },
        setReady(value: boolean) { ready = value; },
        dispose() {
            if (disposed) return;
            disposeRequested = true;
            if (suspended) {
                disposed = true;
                if (locks.get(scope) === lock) locks.delete(scope);
            } else hide();
            clearInterval(timer);
            closeChannel();
            window.removeEventListener("storage", storage);
            window.removeEventListener("pagehide", hide);
            window.removeEventListener("pageshow", show);
        },
    };
    locks.set(scope, lock);
    window.addEventListener("storage", storage);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    try {
        if (typeof BroadcastChannel !== "undefined") {
            channel = new BroadcastChannel("infinite-canvas:writer");
            channel.onmessage = (event: MessageEvent<Signal>) => receive(event.data);
            channel.onmessageerror = () => { closeChannel(); inspect(); };
        }
    } catch { channel = null; }
    try { signal("hello"); } catch { /* inspect reports storage failure */ }
    inspect();
    const timer = setInterval(inspect, 250);
    return lock;
}
