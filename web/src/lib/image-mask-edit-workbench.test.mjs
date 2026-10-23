import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const promptSource = readFileSync(new URL("lib/image-reference-prompt.ts", root), "utf8");
const dialogSource = readFileSync(new URL("app/(user)/canvas/components/canvas-node-mask-edit-dialog.tsx", root), "utf8");
const canvasPageSource = readFileSync(new URL("app/(user)/canvas/[id]/canvas-client-page.tsx", root), "utf8");

const promptModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(promptSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: promptModule.exports, module: promptModule });

const MASK_EDIT_PROMPT_PREFIX = "参考图中蓝色高亮覆盖区域是需要修改的位置，蓝色只是编辑标记，不要保留在最终图像中。只修改蓝色高亮区域，其他区域的构图、人物、文字、光影和风格保持不变。修改要求：";

test("局部重绘提示词前缀常量已导出且文案不变", () => {
    assert.equal(promptModule.exports.IMAGE_MASK_EDIT_PROMPT_PREFIX, MASK_EDIT_PROMPT_PREFIX,
        `IMAGE_MASK_EDIT_PROMPT_PREFIX actual=${JSON.stringify(promptModule.exports.IMAGE_MASK_EDIT_PROMPT_PREFIX)}`);
});

test("画布局部编辑复用前缀常量，不再内联同一段文案", () => {
    assert.ok(/import \{ IMAGE_MASK_EDIT_PROMPT_PREFIX \} from "@\/lib\/image-reference-prompt"/.test(canvasPageSource),
        "canvas page must import IMAGE_MASK_EDIT_PROMPT_PREFIX");
    assert.ok(canvasPageSource.includes("`${IMAGE_MASK_EDIT_PROMPT_PREFIX}${userPrompt}`"),
        "canvas page must build the mask prompt from the shared prefix");
    assert.ok(!canvasPageSource.includes("蓝色高亮覆盖区域是需要修改的位置"),
        "inline copy must be removed from canvas page so the prefix has one source");
});

test("局部重绘对话框提交结束时用 finally 复位 submitting", () => {
    const submit = dialogSource.match(/const submit = async \(\) => \{[\s\S]*?\n    \};/);
    assert.ok(submit, "submit handler not found");
    assert.match(submit[0], /finally \{\s*setSubmitting\(false\);\s*\}/,
        "actual submit body:\n" + submit[0]);
    assert.ok(!/catch \{\s*setSubmitting\(false\);/.test(submit[0]),
        "submitting must be reset in finally, not only in the catch branch");
});
