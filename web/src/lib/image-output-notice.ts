export function imageOutputNoticeText(code: string) {
    if (code === "undeclared") return "该模型未声明输出格式能力，保持自动输出";
    if (code === "upstream-no-alpha") return "上游未返回透明通道";
    if (code === "upstream-alpha-unverified") return "上游图片透明通道无法验证";
    if (code === "fallback-default") return "当前渠道不支持所选格式，已按渠道能力回退";
    return "";
}

// 「模型未声明输出格式能力」是纯信息性提示：行为本来就是保持自动输出，用户没有可操作项，
// 设置面板里也已有同一句内联说明。若逐次弹 toast，选中未声明能力的模型（如 Gemini 渠道）时
// 每生成一张图都会弹一次，属于噪音。这里只对它降噪，其余可操作的提示保持原行为。
export function shouldNotifyImageOutputNotice(code: string) {
    return code !== "undeclared";
}

// 同一组合（渠道:模型:提示码）每会话只提示一次。
// 仅靠「2 秒内同 key 去重」不够：画布任务的通知键曾是 taskId（每个任务都不同），
// 只要两次生成间隔超过 2 秒就会重复提示。
export function createImageOutputNoticeGate() {
    const seen = new Set<string>();
    return (key: string) => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    };
}
