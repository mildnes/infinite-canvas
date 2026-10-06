export type PromptToken = { type: "text"; value: string } | { type: "reference"; label: string };

// 图片/视频等引用标签的解析规则：
// - 标签后不允许紧邻英数字符，避免“图片1”误伤“图片176/图片10”、“图片2”误伤“图片221”等更长编号；
// - 允许出现在中文标点、空格、括号等正常边界处。
export function parsePromptTokens(value: string, labels: string[]): PromptToken[] {
    if (!labels.length) return value ? [{ type: "text", value }] : [];
    const pattern = new RegExp(`@?(${labels.map(escapeRegExp).join("|")})(?![0-9A-Za-z])`, "g");
    const tokens: PromptToken[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
        if (match.index === undefined) continue;
        if (match.index > lastIndex) {
            tokens.push({
                type: "text",
                value: value.slice(lastIndex, match.index),
            });
        }
        tokens.push({
            type: "reference",
            label: match[0],
        });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) {
        tokens.push({
            type: "text",
            value: value.slice(lastIndex),
        });
    }
    return tokens;
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
