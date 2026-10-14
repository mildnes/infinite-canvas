export const WORKBENCH_TASK_INTERRUPTED_AFTER_MS = 30 * 60 * 1000;

export type MissingTaskOutcome =
    | { status: "success" }
    | { status: "pending" }
    | { status: "failed"; error: string };

export function resolveMissingTaskOutcome(options: { hasImages: boolean; createdAt: number; now: number }): MissingTaskOutcome {
    if (options.hasImages) return { status: "success" };
    if (options.now - options.createdAt < WORKBENCH_TASK_INTERRUPTED_AFTER_MS) return { status: "pending" };
    return { status: "failed", error: "任务记录已过期（无法确认结果，可重新生成）" };
}
