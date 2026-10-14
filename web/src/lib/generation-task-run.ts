export type TaskKind = "image" | "audio" | "video" | "workflow";
export type TaskRun = { id: string; controller: AbortController; taskId?: string; kind: TaskKind; token: string; stopping?: boolean };
let runSequence = 0;

export function beginTaskRun(runs: Map<string, TaskRun>, key: string, kind: TaskKind, taskId: string, token: string): TaskRun {
    runs.get(key)?.controller.abort();
    const run = { id: String(++runSequence), controller: new AbortController(), taskId, kind, token };
    runs.set(key, run);
    return run;
}

export function currentTaskRun(runs: Map<string, TaskRun>, key: string, run: TaskRun, token: string) {
    return runs.get(key)?.id === run.id && !run.controller.signal.aborted && token === run.token;
}

export function isStoppedTask(status?: string) {
    return ["cancelled", "canceled"].includes((status || "").toLowerCase());
}

export function acceptsTaskUpdate(status: string | undefined, _incoming: string | undefined) {
    return !["cancelled", "success", "error"].includes(status || "");
}

export function taskStopAction(status?: string, stopState?: "stopping" | "failed") {
    if (status === "cancelled") return { label: "重新生成", disabled: false };
    if (status !== "loading") return null;
    return { label: stopState === "stopping" ? "停止中" : stopState === "failed" ? "重试停止" : "停止", disabled: stopState === "stopping" };
}

export type CanvasTaskPollState = { taskId: string; errorCount: number; nextPollAt: number; stopped: boolean; errorDetails?: string };
export const CANVAS_TASK_POLL_ERROR_LIMIT = 5;

export function recordCanvasTaskPollError(taskId: string, error: unknown, previous?: CanvasTaskPollState, now = Date.now()): CanvasTaskPollState {
    const failure = error as { status?: number; response?: { status?: number }; message?: string } | undefined;
    const missing = (failure?.status ?? failure?.response?.status) === 404 || /^(图片|音频|视频|工作流)任务不存在(?:或未创建成功)?$/.test(failure?.message || "");
    const errorCount = (previous?.taskId === taskId ? previous.errorCount : 0) + 1;
    const stopped = missing || errorCount >= CANVAS_TASK_POLL_ERROR_LIMIT;
    return {
        taskId, errorCount, stopped,
        nextPollAt: now + Math.min(30000, 5000 * 2 ** (errorCount - 1)),
        errorDetails: stopped ? missing ? "任务记录不存在，无法确认结果，请重新查询。" : "任务查询连续失败，已暂停；请检查网络后重新查询。" : undefined,
    };
}

export function canPollCanvasTask(taskId: string, previous?: CanvasTaskPollState, now = Date.now()) {
    return previous?.taskId !== taskId || (!previous.stopped && now >= previous.nextPollAt);
}

export function canvasTaskRetryMode(status: string | undefined, pollingError: boolean | undefined, taskId: string) {
    return taskId && (pollingError || status === "loading") ? "lookup" : "generate";
}

export async function pollCanvasTaskRequest<T>(request: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs = 15000): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (complete: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            complete();
        };
        const cancel = () => finish(() => {
            controller.abort(signal?.reason);
            reject(signal?.reason || new DOMException("任务查询已取消", "AbortError"));
        });
        const timer = setTimeout(() => finish(() => {
            controller.abort();
            reject(new Error("任务查询超时，请稍后重新查询"));
        }), timeoutMs);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        if (!settled) Promise.resolve().then(() => request(controller.signal)).then((task) => finish(() => resolve(task)), (error) => finish(() => reject(error)));
    });
}
