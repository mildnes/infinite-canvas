import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("../app/(user)/canvas/[id]/canvas-client-page.tsx", import.meta.url), "utf8");
const storeSource = readFileSync(new URL("../app/(user)/canvas/stores/use-canvas-store.ts", import.meta.url), "utf8");

function blockAfter(source, marker, length = 2400) {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `missing source marker: ${marker}`);
    return source.slice(start, start + length);
}

test("JWT 轮换后同账号仍保留画布保存资格", () => {
    const persistBlock = blockAfter(pageSource, "persistCurrentCanvasRef.current =");
    assert.match(persistBlock, /loadedProjectRef\.current\.ownerId\s*!==\s*currentCanvasOwnerId\(\)/);
    assert.doesNotMatch(persistBlock, /loadedProjectRef\.current\.(?:token|ownerToken)\s*!==\s*useUserStore\.getState\(\)\.token/);
    assert.match(pageSource, /loadedProjectRef = useRef<\{ id: string; ownerId: string \} \| null>/);
});

test("restore 只按账号变化重载，并且所有早退都经过世代化 finally 解锁", () => {
    const restoreBlock = blockAfter(pageSource, "useEffect(() => {\n        if (!hydrated) return;", 5200);
    assert.doesNotMatch(restoreBlock, /\}, \[currentUserToken,\s*hydrated,/);
    assert.match(restoreBlock, /restoreGenerationRef/);
    assert.match(restoreBlock, /finally\s*\{/);
    assert.match(restoreBlock, /if \(restoreGenerationRef\.current === restoreGeneration\)/);
    assert.match(restoreBlock, /currentCanvasOwnerId\(\) === ownerId/);
});

test("同账号 token 变化会触发本地保底与远端重试哨兵", () => {
    assert.match(pageSource, /token 变化|token轮换|JWT/);
    assert.match(pageSource, /retrySaves\(\)/);
    assert.match(pageSource, /SAVE_STALL/);
    assert.match(pageSource, /message\.warning\(/);
});

test("store 保存请求的生命周期只由账号与 owner epoch 判定", () => {
    const flushBlock = blockAfter(storeSource, "async function flushProjectSave", 2600);
    assert.match(flushBlock, /currentStorageOwnerId\(\) === owner/);
    assert.match(flushBlock, /epoch === ownerEpoch/);
    assert.doesNotMatch(flushBlock, /useUserStore\.getState\(\)\.token === token/);
});
