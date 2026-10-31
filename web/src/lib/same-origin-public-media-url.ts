function privateMediaHostname(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    if (host === "localhost" || host.endsWith(".localhost") || host === "local" || host.endsWith(".local")) return true;
    if (host === "::" || host === "::1" || /^(fc|fd|fe[89ab])/.test(host)) return true;
    const mapped = host.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/);
    if (mapped) {
        const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
        return privateMediaHostname(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || !parts.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return false;
    return [0, 10, 127].includes(parts[0]) || (parts[0] === 192 && parts[1] === 168)
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254);
}

export function publicMediaOrigin(origin?: string): string {
    const value = origin ?? (typeof window === "undefined" ? undefined : window.location.origin);
    if (!value) return "";
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || privateMediaHostname(url.hostname)) return "";
        return url.origin;
    } catch {
        return "";
    }
}

export function sameOriginPublicMediaUrl(value?: string, origin?: string): string {
    if (!value) return "";
    const base = publicMediaOrigin(origin);
    if (!base) return "";
    try {
        const url = new URL(value, base);
        if (!["http:", "https:"].includes(url.protocol) || url.origin !== base || url.username || url.password
            || !/^\/api\/files\/[^/]+\/(content|preview)$/.test(url.pathname)) return "";
        return url.href;
    } catch {
        return "";
    }
}
