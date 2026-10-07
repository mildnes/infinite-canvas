// Display-only switch: originals remain the source for generation, export and download.
export const CANVAS_IMAGE_PREVIEWS_ENABLED = true;

export function previewSrcFor(original: string, storageKey?: string) {
    if (!CANVAS_IMAGE_PREVIEWS_ENABLED) return original;
    const match = original.match(/^(https?:\/\/[^/]+)?\/api\/(?:v1\/)?files\/([A-Za-z0-9_-]+)\/content(?:[?#].*)?$/);
    // Bypass previously issued one-year immutable previews; node URLs stay original.
    if (match) return `${match[1] || ""}/api/files/${match[2]}/preview?v=2`;
    const id = storageKey?.match(/^server:([A-Za-z0-9_-]+)$/)?.[1];
    return id ? `/api/files/${id}/preview?v=2` : original;
}

export function fallbackCanvasPreview(image: HTMLImageElement, original: string) {
    if (image.getAttribute("src") !== original) image.setAttribute("src", original);
}

type OriginalLoader = Pick<HTMLImageElement, "src" | "onload" | "onerror">;

// The caller cancels on close/source change; late loads cannot affect another node.
export function loadOriginalImage(src: string, complete: (status: "ready" | "failed") => void, create: () => OriginalLoader = () => new Image()) {
    const image = create();
    let active = true;
    image.onload = () => { if (active) complete("ready"); };
    image.onerror = () => { if (active) complete("failed"); };
    image.src = src;
    return () => { active = false; image.onload = null; image.onerror = null; };
}
