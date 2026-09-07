export function resolveCanvasAgentSkillPrompts(
    activeSkillContents: string | undefined,
    explicitSkillPrompts: string[],
    automaticSkillPrompts: string[],
    explicitSelection = Boolean(activeSkillContents || explicitSkillPrompts.length),
) {
    return {
        explicitSelection,
        prompts: explicitSelection
            ? [...explicitSkillPrompts.filter(Boolean), ...(activeSkillContents ? [activeSkillContents] : [])]
            : [...automaticSkillPrompts.filter(Boolean), ...explicitSkillPrompts.filter(Boolean)],
    };
}
