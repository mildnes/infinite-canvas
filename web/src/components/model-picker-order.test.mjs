import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 守卫：模型选择器的显示顺序 = 后端 settings.private.channels 的数组顺序。
 *
 * 管理端「渠道」列表用 ↑ ↓ 调整这个数组顺序（见 admin/settings/page.tsx 的
 * moveChannel 调用），前端只负责按序渲染。如果这里加了二次排序（按字母、
 * 按能力、按名称等），后台的排序入口就失效了 —— 所以用源码扫描把它钉住。
 */
const source = readFileSync(new URL("./model-picker.tsx", import.meta.url), "utf8");

test("模型列表按渠道顺序 flatMap 生成（不重排）", () => {
    assert.match(
        source,
        /flatMap\(\(channel\) => \(channel\.models \?\? \[\]\)\.map\(/,
        "模型列表必须由 channels 依序 flatMap 得到",
    );
});

test("渠道来源是配置里的 publicChannels（保持后端返回顺序）", () => {
    assert.match(source, /config\.publicChannels\.map\(/, "远端模式必须直接按 publicChannels 顺序取渠道");
});

test("选择器内不得对模型/渠道列表做二次排序", () => {
    assert.doesNotMatch(source, /\.sort\(/, "model-picker 里不允许出现 .sort()");
    assert.doesNotMatch(source, /localeCompare/, "model-picker 里不允许按本地化顺序排序");
});

test("排序入口只在管理端（moveChannel 工具 + 渠道表按钮）", () => {
    const admin = readFileSync(
        new URL("../app/(admin)/admin/settings/page.tsx", import.meta.url),
        "utf8",
    );
    assert.match(admin, /moveChannel\(channels, item\._index, -1\)/, "管理端应提供上移");
    assert.match(admin, /moveChannel\(channels, item\._index, 1\)/, "管理端应提供下移");
});
