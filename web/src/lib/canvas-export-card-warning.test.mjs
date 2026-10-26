// 单画板卡片导出必须与列表页一致：报告云端素材数量、报告缺失素材、清理 loading。
// 旧实现直接 `await exportCanvasProjects(...)` 丢掉返回值，下载失败时用户无感知。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CARD = new URL("../app/(user)/canvas/components/canvas-project-card.tsx", import.meta.url);
const PAGE = new URL("../app/(user)/canvas/page.tsx", import.meta.url);
const card = readFileSync(CARD, "utf8");
const page = readFileSync(PAGE, "utf8");

function exportBlock() {
    const start = card.indexOf("const exportProject = async () => {");
    assert.ok(start >= 0, "找不到 exportProject");
    let depth = 0, begun = false;
    for (let i = start; i < card.length; i++) {
        if (card[i] === "{") { depth++; begun = true; }
        else if (card[i] === "}") { depth--; if (begun && depth === 0) return card.slice(start, i + 1); }
    }
    throw new Error("exportProject 未闭合");
}

test("卡片导出必须接收导出结果并提示缺失素材", () => {
    const block = exportBlock();
    assert.ok(/const result = await exportCanvasProjects\(/.test(block),
        "必须接收 exportCanvasProjects 的返回值，否则拿不到 missing 清单");
    assert.ok(/result\.missing\.length/.test(block), "必须检查缺失清单");
    assert.ok(/message\.warning\(/.test(block), "有缺失时必须可见提示，不能静默");
    assert.ok(/item\.storageKey/.test(block) && /item\.reason/.test(block), "缺失提示要带 storageKey 与原因");
});

test("卡片导出要有云端素材数量提示与 loading 清理", () => {
    const block = exportBlock();
    assert.ok(/countCanvasCloudAssets\(\[complete\]\)/.test(block), "导出前要统计云端素材数量");
    assert.ok(/message\.loading\(/.test(block), "有云端素材时应提示正在导出");
    assert.ok(/finally \{ message\.destroy\(loadingKey\); \}/.test(block), "loading 必须在 finally 清理");
});

test("卡片导出的 loadProject 结果为空时不再继续", () => {
    const block = exportBlock();
    assert.ok(/if \(!complete\) return;/.test(block), "画板加载失败时不得继续导出");
});

test("与列表页导出行为对齐（同一套提示语义）", () => {
    assert.ok(/countCanvasCloudAssets\(loaded\)/.test(page), "列表页已有数量提示");
    assert.ok(/result\.missing\.length/.test(page) && /message\.warning\(/.test(page), "列表页已有缺失提示");
    const block = exportBlock();
    // 两处都必须引用同一个结果字段名，避免以后只改一处
    assert.ok(/result\.missing/.test(page) && /result\.missing/.test(block));
});
