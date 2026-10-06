export const IMAGE_PREVIEW_SIDE = 1024;
const prepared = new WeakMap<Blob, Promise<Blob | null>>();
let active = 0;
const waiting: (() => void)[] = [];

export function previewDimensions(width: number, height: number) {
    const scale = Math.min(1, IMAGE_PREVIEW_SIDE / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function encodePreview(blob: Blob): Promise<Blob> {
    let bitmap: ImageBitmap | undefined;
    let element: HTMLImageElement | undefined;
    let url: string | undefined;
    try {
        if (typeof createImageBitmap === "function") {
            try { bitmap = await createImageBitmap(blob); } catch { /* Safari/format fallback. */ }
        }
        if (!bitmap) {
            url = URL.createObjectURL(blob);
            element = new Image();
            await new Promise<void>((resolve, reject) => {
                element!.onload = () => resolve();
                element!.onerror = () => reject(new Error("图片预览解码失败"));
                element!.src = url!;
            });
        }
        const source = bitmap || element!;
        const size = previewDimensions(bitmap?.width || element!.naturalWidth, bitmap?.height || element!.naturalHeight);
        const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(size.width, size.height) : Object.assign(document.createElement("canvas"), size);
        const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!context) throw new Error("图片预览画布不可用");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, size.width, size.height);
        context.drawImage(source, 0, 0, size.width, size.height);
        if ("convertToBlob" in canvas) return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片预览编码失败")), "image/jpeg", 0.8));
    } finally {
        bitmap?.close();
        if (url) URL.revokeObjectURL(url);
    }
}

// Use bytes already held by an upload; never fetch another original to make a preview.
export function prepareImagePreview(blob: Blob): Promise<Blob | null> {
    if (!blob.type.startsWith("image/") || typeof document === "undefined") return Promise.resolve(null);
    const existing = prepared.get(blob);
    if (existing) return existing;
    if (waiting.length >= 64) return Promise.resolve(null);
    const promise = (async () => {
        if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
        else active++;
        try { return await encodePreview(blob); } catch { return null; } finally {
            const next = waiting.shift();
            if (next) next(); else active--;
        }
    })();
    prepared.set(blob, promise);
    return promise;
}
