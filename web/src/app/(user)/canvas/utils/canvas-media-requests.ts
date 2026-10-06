import { createCanvasImageTask } from "@/services/api/image";
import { createVideoGenerationTask } from "@/services/api/video";
import { stripReferenceMetadata } from "./prompt-reference-metadata";

export function canvasMediaRequestPrompt(mode: "image" | "video" | "audio", prompt: string, allowEmpty = false) {
    if (mode === "audio") return prompt;
    const requestPrompt = stripReferenceMetadata(prompt);
    if (!allowEmpty && !requestPrompt.trim()) throw new Error("清洗后的图片或视频提示词为空，未提交生成请求");
    return requestPrompt;
}

// 画布图片五个入口（局部编辑、图片编辑、全景、普通/批量、重试）必须经过此处。
// 相机/全景/上游文本已拼接完成；只复制提交参数，不回写节点 prompt 或 panoramaFinalPrompt。
export async function submitCanvasImageRequest(...args: Parameters<typeof createCanvasImageTask>): ReturnType<typeof createCanvasImageTask> {
    const requestArgs: Parameters<typeof createCanvasImageTask> = [...args];
    requestArgs[1] = canvasMediaRequestPrompt("image", args[1]);
    return createCanvasImageTask(...requestArgs);
}

// 画布视频普通生成与重试必须经过此处；工作流的 image/video 分支使用同一清洗函数。
// 只清 prompt，Kling multi_prompt 和 element_list 等独立配置文本不变。
export async function submitCanvasVideoRequest(...args: Parameters<typeof createVideoGenerationTask>): ReturnType<typeof createVideoGenerationTask> {
    const requestArgs: Parameters<typeof createVideoGenerationTask> = [...args];
    requestArgs[1] = canvasMediaRequestPrompt("video", args[1]);
    return createVideoGenerationTask(...requestArgs);
}
