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
