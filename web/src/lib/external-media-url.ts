export function externalMediaURL(value?: string, baseOrigin?: string) {
    if (!value || value.startsWith("blob:") || value.startsWith("data:")) return "";
    try {
        const url = new URL(value, baseOrigin || (typeof window === "undefined" ? undefined : window.location.origin));
        if (!["http:", "https:"].includes(url.protocol)) return "";
        if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return "";
        if (baseOrigin && url.origin === new URL(baseOrigin).origin) return "";
        if (!baseOrigin && typeof window !== "undefined" && url.origin === window.location.origin) return "";
        return url.href;
    } catch {
        return "";
    }
}
