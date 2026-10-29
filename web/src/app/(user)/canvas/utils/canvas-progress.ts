/**
 * 生图/生成节点的进度插值。
 *
 * 背景：上游（RunningHub / 工作流）只在几个固定台阶返回 progress：
 *   0（排队）→ 10（已提交，等待上游）→ 30（上游已认领）→ 100（完成）。
 * 其中 10 会持续很久，界面看起来"卡在 10%"，用户无法判断是否还在推进。
 *
 * 处理：以后端台阶值为下界，按已用时间做渐近插值，缓慢逼近但永不超过 90%，
 * 完成时由后端返回的 100 直接覆盖（本函数对 >= 100 原样返回）。
 * 这样既有连续反馈，又不会在任务真正完成前谎报 100%。
 */

export const CANVAS_PROGRESS_CAP = 90;
/** 期望总时长（毫秒）。实测 4K 生图约 2 分钟，这里取 120 秒作为曲线尺度。 */
export const CANVAS_PROGRESS_EXPECTED_MS = 120_000;

export function interpolateGenerationProgress(
    baseProgress: number,
    elapsedMs: number,
    expectedMs: number = CANVAS_PROGRESS_EXPECTED_MS,
): number {
    const base = Number.isFinite(baseProgress) ? Math.max(0, Math.min(100, Math.round(baseProgress))) : 0;
    // 已完成或超出：不插值，原样返回
    if (base >= 100) return 100;
    // 已完成度已到或超过上限：锁在上限
    if (base >= CANVAS_PROGRESS_CAP) return CANVAS_PROGRESS_CAP;

    const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
    const scale = Number.isFinite(expectedMs) && expectedMs > 0 ? expectedMs : CANVAS_PROGRESS_EXPECTED_MS;
    if (elapsed === 0) return base;

    // 渐近曲线：ratio=1 时约完成 86%，ratio=2 时约 98%，永不越过上限
    const ratio = elapsed / scale;
    const approached = 1 - Math.exp(-ratio * 2);
    const value = base + (CANVAS_PROGRESS_CAP - base) * approached;
    return Math.max(base, Math.min(CANVAS_PROGRESS_CAP, Math.round(value)));
}
