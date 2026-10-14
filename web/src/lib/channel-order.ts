/**
 * 渠道排序工具。
 *
 * 后端 settings.private.channels 的**数组顺序**就是前端模型选择器的显示顺序
 * （service/settings.go 的 enabledChannelModels 按渠道顺序拼接；
 *  web/src/components/model-picker.tsx 按渠道顺序 flatMap，均不做二次排序）。
 * 因此调整数组顺序即可改变前端的展示顺序。
 */

/** 把 index 处的元素向 delta 方向移动一位（delta 为 -1 上移、1 下移）。越界或非法入参时原样返回。 */
export function moveChannel<T>(channels: T[], index: number, delta: number): T[] {
    if (!Array.isArray(channels)) return channels;
    if (!Number.isInteger(index) || !Number.isInteger(delta) || delta === 0) return channels;
    if (index < 0 || index >= channels.length) return channels;
    const target = index + delta;
    if (target < 0 || target >= channels.length) return channels;
    const next = channels.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    return next;
}
