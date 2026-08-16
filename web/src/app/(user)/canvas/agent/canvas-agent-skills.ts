import type { CanvasAgentPhase, CanvasAgentSkillReference } from "../types";
import { serializeCanvasAgentContext, type CanvasAgentContext } from "./canvas-agent-context";
import { AUDIO_SKILL } from "./skills/audio";
import { CORE_SKILL } from "./skills/core";
import { IMAGE_SKILL } from "./skills/image";
import { IMAGE_CHARACTER_SHEET_SKILL } from "./skills/image-character-sheet";
import { IMAGE_STORYBOARD_SKILL } from "./skills/image-storyboard";
import { ORGANIZE_SKILL } from "./skills/organize";
import { SCRIPT_SKILL } from "./skills/script";
import { VIDEO_SKILL } from "./skills/video";
import { VIDEO_EDITING_SKILL } from "./skills/video-editing";
import { VIDEO_EXTENSION_SKILL } from "./skills/video-extension";
import { VIDEO_MULTI_SHOT_SKILL } from "./skills/video-multi-shot";
import { VIDEO_SINGLE_SHOT_SKILL } from "./skills/video-single-shot";
import { WORKFLOW_SKILL } from "./skills/workflow";

export const BUILTIN_CANVAS_AGENT_SKILLS: Array<CanvasAgentSkillReference & { prompt: string }> = [
    { id: "builtin:core", name: "核心执行规范", description: "画布 Agent 的基础执行规则", source: "builtin", prompt: CORE_SKILL },
    { id: "builtin:workflow", name: "工作流规划", description: "从想法到画布工作流的规划", source: "builtin", prompt: WORKFLOW_SKILL },
    { id: "builtin:script", name: "剧本与文案", description: "剧本、对白、旁白和文案拆解", source: "builtin", prompt: SCRIPT_SKILL },
    { id: "builtin:image", name: "图片创作", description: "图片生成、编辑和参考图规划", source: "builtin", prompt: IMAGE_SKILL },
    { id: "builtin:image-character-sheet", name: "角色设定表", description: "角色身份、服装和多视图设定", source: "builtin", prompt: IMAGE_CHARACTER_SHEET_SKILL },
    { id: "builtin:image-storyboard", name: "图片分镜板", description: "分镜拼图和故事板创作", source: "builtin", prompt: IMAGE_STORYBOARD_SKILL },
    { id: "builtin:video", name: "视频创作", description: "视频生成和镜头设计", source: "builtin", prompt: VIDEO_SKILL },
    { id: "builtin:video-single-shot", name: "单镜头视频", description: "单镜头视频生成", source: "builtin", prompt: VIDEO_SINGLE_SHOT_SKILL },
    { id: "builtin:video-multi-shot", name: "多镜头视频", description: "多镜头视频规划和执行", source: "builtin", prompt: VIDEO_MULTI_SHOT_SKILL },
    { id: "builtin:video-editing", name: "视频编辑", description: "视频重绘、改风格和局部修改", source: "builtin", prompt: VIDEO_EDITING_SKILL },
    { id: "builtin:video-extension", name: "视频续写", description: "视频续写和连续镜头设计", source: "builtin", prompt: VIDEO_EXTENSION_SKILL },
    { id: "builtin:audio", name: "音频与配音", description: "旁白、对白和音频生成", source: "builtin", prompt: AUDIO_SKILL },
    { id: "builtin:organize", name: "画布整理", description: "节点分组、布局和整理", source: "builtin", prompt: ORGANIZE_SKILL },
];

export function builtinCanvasAgentSkill(id: string) {
    return BUILTIN_CANVAS_AGENT_SKILLS.find((skill) => skill.id === id);
}

export function buildCanvasAgentSkillPrompt(phase: CanvasAgentPhase, userText: string, context: CanvasAgentContext) {
    return buildCanvasAgentSkillPromptWithExtra(phase, userText, context, []);
}

export function buildCanvasAgentSkillPromptWithExtra(phase: CanvasAgentPhase, userText: string, context: CanvasAgentContext, extraSkills: string[]) {
    const intent = buildIntentText(userText, context);
    const selectedTypes = new Set<string>(context.nodes.filter((node) => context.selectedNodeIds.includes(node.id)).map((node) => node.type));
    const skills = [CORE_SKILL, WORKFLOW_SKILL];

    const oneOffMedia = /生成一张|生成图片|生图|改图|生成视频|视频生成|文生视频|图生视频|生成音频|独立音频|生成旁白|旁白音频|配音|音色|朗读/.test(userText) && !/故事|剧情|剧本|脚本|宣传片|广告|短片|多镜头|完整制作|从头开始/.test(userText);
    const wantsScript = ["concept", "script", "breakdown"].includes(phase) || (phase === "intake" && !oneOffMedia) || /故事|剧情|剧本|脚本|文案|对白|旁白|分镜头|拆镜头|镜头拆解|宣传片|广告|梗概|改写|人物小传|角色需求|场景需求/.test(intent);
    const wantsImage =
        phase === "references" ||
        phase === "storyboard" ||
        selectedTypes.has("image") ||
        selectedTypes.has("panorama") ||
        /图片|生图|图像|角色图|产品图|产品标准|产品参考|商品参考|汽车参考|包装参考|材质参考|内饰参考|场景图|参考图|设定图|设定表|四视图|分镜|宫格|拼图|关键帧|改图|换装|肖像|海报/.test(intent);
    const wantsCharacterSheet = wantsImage && (/四视图|设定表|角色设定|人物设定|角色参考|身份一致|角色一致|换装|服装变体|年龄变体|受伤|湿透|脏污|转面/.test(intent) || (phase === "references" && /角色|人物|演员|主角|配角/.test(intent)));
    const wantsStoryboard = phase === "storyboard" || /分镜拼图|分镜板|故事板|storyboard|宫格|拼图|mosaic|连续分镜|镜头预演/.test(intent);
    const wantsVideo = phase === "video" || selectedTypes.has("video") || /生成视频|做视频|视频生成|文生视频|图生视频|让.+动起来|动画化|渲染镜头|生成片段|视频续写|续写视频|编辑视频|修改视频|重绘视频|运镜|一镜到底/.test(intent);
    const wantsExtension = wantsVideo && (/续写|继续视频|接着视频|延长|下一段|后续片段|前传|向前补拍|补拍|连续片段|连续镜头|一镜到底|同机位|串行|链式/.test(intent) || (selectedTypes.has("video") && /继续|接着|往后|下一段|延长|前面/.test(userText)));
    const wantsVideoEdit =
        wantsVideo && (/编辑视频|修改视频|重绘视频|重制视频|重渲染|换风格|改风格|调色|局部修改|局部编辑|替换主体|替换产品|换成|动作改写|重新设计动作/.test(intent) || (selectedTypes.has("video") && /改|修改|调整|换|替换|编辑|重做|重绘/.test(userText)));
    const wantsMultiShot =
        wantsVideo &&
        (/多镜头|多段镜头|镜头序列|广告片|品牌片|宣传片|音乐视频|MV|蒙太奇|分镜拼图|分镜板|storyboard|能量弧|密度图/.test(intent) ||
            context.nodes.some((node) => context.selectedNodeIds.includes(node.id) && /分镜拼图|分镜板|storyboard/i.test(node.title)));
    const wantsAudio = phase === "audio" || selectedTypes.has("audio") || /独立音频|音色|配音|声音样本|角色声音|角色音色|对白音频|旁白|最终对白|最终旁白|朗读|语音/.test(intent);
    const wantsOrganize = phase === "references" || phase === "review" || phase === "complete" || /分组|整理|布局|归类|排列|收纳|画布太乱|自动整理/.test(intent);

    if (wantsScript) skills.push(SCRIPT_SKILL);
    if (wantsImage) skills.push(IMAGE_SKILL);
    if (wantsCharacterSheet) skills.push(IMAGE_CHARACTER_SHEET_SKILL);
    if (wantsStoryboard) skills.push(IMAGE_STORYBOARD_SKILL);
    if (wantsVideo) {
        skills.push(VIDEO_SKILL);
        if (wantsExtension) skills.push(VIDEO_EXTENSION_SKILL);
        if (wantsVideoEdit) skills.push(VIDEO_EDITING_SKILL);
        if (wantsMultiShot) skills.push(VIDEO_MULTI_SHOT_SKILL);
        if (!wantsExtension && !wantsVideoEdit && !wantsMultiShot) skills.push(VIDEO_SINGLE_SHOT_SKILL);
    }
    if (wantsAudio) skills.push(AUDIO_SKILL);
    if (wantsOrganize) skills.push(ORGANIZE_SKILL);

    return [...new Set([...skills, ...extraSkills.filter(Boolean)])].join("\n\n") + "\n\n【当前真实画布上下文 JSON】\n" + serializeCanvasAgentContext(context);
}

function buildIntentText(userText: string, context: CanvasAgentContext) {
    const selectedText = context.nodes
        .filter((node) => context.selectedNodeIds.includes(node.id))
        .map((node) => [node.title, node.prompt, node.text].filter(Boolean).join(" "))
        .join(" ");
    return [userText, context.agentState.brief, context.agentState.approvedPlan, selectedText].filter(Boolean).join(" ");
}
