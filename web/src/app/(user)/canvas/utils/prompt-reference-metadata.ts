// 引用溯源标注清洗。
//
// Agent 偶尔会把「文件名 / 用户图片编号」写进提示词正文，例如：
//   仅局部编辑图片1（用户本轮图片237，CZ场景 1.png）。图片1是唯一场景……
//   参考车辆与职责：图片2（用户图片114，7.jpg）、图片3（用户图片160，5860fab8…jpg）
// 这类信息只用于溯源，应写在 Agent 回复或节点备注里；提示词会原样发给生图/生视频模型，
// 双标识是噪音，文件名还可能被模型当画面文字渲染。
//
// 本函数是确定性兜底（技能规则见 skills/core.ts 的编号规则）：把「图片N（用户图片M，文件名）」
// 还原为「图片N」，并删除独立的「（用户本轮图片M，…）」片段。只匹配明确的溯源标注形态，
// 不会碰「图片2（左侧 Logo 唯一原件）」这类职责说明。
const REFERENCE_METADATA = "(?:用户本轮图片|用户图片)\\s*\\d+";

export function stripReferenceMetadata(text: string): string {
    if (!text) return text;
    return text
        .replace(new RegExp(`([图片视频音频]\\d+)[（(]\\s*${REFERENCE_METADATA}\\s*(?:[，,][^）)]*)?[）)]`, "g"), "$1")
        .replace(new RegExp(`[（(]\\s*${REFERENCE_METADATA}\\s*(?:[，,][^）)]*)?[）)]`, "g"), "");
}
