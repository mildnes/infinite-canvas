import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanvasAgentSkillPrompts } from "./canvas-agent-skill-selection.ts";

test("显式 Skill 只保留公共 CORE 与所选内容", () => {
    const selected = resolveCanvasAgentSkillPrompts("ACTIVE", ["SELECTED"], ["AUTO_BACKGROUND"]);
    assert.equal(selected.explicitSelection, true);
    assert.deepEqual(selected.prompts, ["SELECTED", "ACTIVE"]);
});

test("未显式选择 Skill 时保留自动 workflow 与意图路由", () => {
    const selected = resolveCanvasAgentSkillPrompts(undefined, [], ["WORKFLOW", "AUTO_BACKGROUND"]);
    assert.equal(selected.explicitSelection, false);
    assert.deepEqual(selected.prompts, ["WORKFLOW", "AUTO_BACKGROUND"]);
});
