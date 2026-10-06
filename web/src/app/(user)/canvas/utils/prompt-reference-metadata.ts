// 引用溯源标注清洗。
//
// Agent 偶尔会把「文件名 / 用户图片编号」写进提示词正文，例如：
//   仅局部编辑图片1（用户本轮图片237，CZ场景 1.png）。图片1是唯一场景……
//   参考车辆与职责：图片2（用户图片114，7.jpg）、图片3（用户图片160，5860fab8…jpg）
// 这类信息只用于溯源，应写在 Agent 回复或节点备注里；提示词会原样发给生图/生视频模型，
// 双标识是噪音，文件名还可能被模型当画面文字渲染。
//
// 只清理带明确用户媒体编号的完整括号；职责说明、未知文件类型及不完整括号保留。
const USER_REFERENCE = /^用户(?:本轮)?(?:图片|视频|音频)\s*\d+$/;
const MEDIA_FILENAME = /^[^\r\n，,；;。！？!?<>:"|]+\.(?:png|apng|jpg|jpeg|jfif|webp|gif|avif|bmp|tif|tiff|heic|heif|svg|mp4|m4v|mov|webm|mkv|avi|3gp|mp3|wav|m4a|aac|flac|ogg|opus|aiff|wma|amr)$/i;
const UNKNOWN_FILENAME = /\.[a-z0-9]+$/i;
const CLOSING_BRACKET: Record<string, string> = { "(": ")", "（": "）" };

export function stripReferenceMetadata(text: string): string {
    let result = "";
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        if (!CLOSING_BRACKET[text[index]]) continue;
        const end = closingBracketIndex(text, index);
        if (end < 0) break;
        result += text.slice(start, index);
        const content = text.slice(index + 1, end);
        const fields = splitMetadataFields(content);
        const values = fields.map((field) => field.value.trim());
        const hasSource = values.some((value) => USER_REFERENCE.test(value));
        const hasUnknownFile = values.some((value) => UNKNOWN_FILENAME.test(value) && !MEDIA_FILENAME.test(value));
        if (hasSource && !hasUnknownFile) {
            const retained = fields.filter((field) => !USER_REFERENCE.test(field.value.trim()) && !MEDIA_FILENAME.test(field.value.trim()));
            const next = retained.map((field, position) => `${position ? field.separator : ""}${field.value}`).join("").trim();
            if (next) result += text[index] + next + text[end];
        } else {
            result += text.slice(index, end + 1);
        }
        index = end;
        start = end + 1;
    }
    return result + text.slice(start);
}

function closingBracketIndex(text: string, start: number) {
    const stack: string[] = [];
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (CLOSING_BRACKET[char]) stack.push(CLOSING_BRACKET[char]);
        else if (char === ")" || char === "）") {
            if (stack.pop() !== char) return -1;
            if (!stack.length) return index;
        }
    }
    return -1;
}

function splitMetadataFields(content: string) {
    const fields: { value: string; separator: string }[] = [];
    let depth = 0;
    let start = 0;
    let separator = "";
    for (let index = 0; index < content.length; index++) {
        const char = content[index];
        if (CLOSING_BRACKET[char]) depth++;
        else if (char === ")" || char === "）") depth--;
        else if (!depth && /[，,；;]/.test(char)) {
            fields.push({ value: content.slice(start, index), separator });
            separator = char;
            start = index + 1;
        }
    }
    fields.push({ value: content.slice(start), separator });
    return fields;
}
