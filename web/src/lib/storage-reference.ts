export function storageKeyFromContentUrl(value: string) {
    const match = value.match(/(?:^|https?:\/\/[^/]+)\/api\/files\/([^/?#]+)\/content(?:[?#]|$)/i);
    if (!match) return "";
    try {
        return `server:${decodeURIComponent(match[1])}`;
    } catch {
        return `server:${match[1]}`;
    }
}
