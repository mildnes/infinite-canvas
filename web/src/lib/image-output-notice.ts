export function imageOutputNoticeText(code: string) {
    if (code === "undeclared") return "该模型未声明输出格式能力，保持自动输出";
    if (code === "upstream-no-alpha") return "上游未返回透明通道";
    if (code === "upstream-alpha-unverified") return "上游图片透明通道无法验证";
    if (code === "fallback-default") return "当前渠道不支持所选格式，已按渠道能力回退";
    return "";
}
