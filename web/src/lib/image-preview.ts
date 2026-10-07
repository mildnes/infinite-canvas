export const IMAGE_PREVIEW_SIDE = 1024;
export type ImagePreviewSourceSize = { width: number; height: number };
const prepared = new WeakMap<Blob, Promise<Blob | null>>();
let active = 0;
const waiting: (() => void)[] = [];

export function previewDimensions(width: number, height: number) {
    const scale = Math.min(1, IMAGE_PREVIEW_SIDE / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Probe decoded pixels after resizing, independent of the source MIME/format.
function hasPreviewTransparency(canvas: OffscreenCanvas | HTMLCanvasElement) {
    const scale = Math.min(1, 64 / Math.max(canvas.width, canvas.height));
    const size = { width: Math.max(1, Math.round(canvas.width * scale)), height: Math.max(1, Math.round(canvas.height * scale)) };
    const probe = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(size.width, size.height) : Object.assign(document.createElement("canvas"), size);
    const context = probe.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error("图片预览透明检测不可用");
    context.drawImage(canvas, 0, 0, size.width, size.height);
    const { data } = context.getImageData(0, 0, size.width, size.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
    return false;
}

async function encodePreview(blob: Blob, sourceSize?: ImagePreviewSourceSize): Promise<Blob> {
    let bitmap: ImageBitmap | undefined;
    let element: HTMLImageElement | undefined;
    let url: string | undefined;
    try {
        if (typeof createImageBitmap === "function") {
            try {
                const resize = sourceSize ? previewDimensions(sourceSize.width, sourceSize.height) : undefined;
                bitmap = await createImageBitmap(blob, resize ? {
                    resizeWidth: resize.width,
                    resizeHeight: resize.height,
                    resizeQuality: "high",
                } : undefined);
            } catch {
                // A known giant source must not fall back to a full-size HTMLImageElement decode.
                if (sourceSize) throw new Error("图片预览解码失败");
            }
        }
        if (!bitmap && sourceSize) throw new Error("图片预览解码不可用");
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
        context.drawImage(source, 0, 0, size.width, size.height);
        const transparent = hasPreviewTransparency(canvas);
        if (!transparent) {
            context.globalCompositeOperation = "destination-over";
            context.fillStyle = "#fff";
            context.fillRect(0, 0, size.width, size.height);
        }
        const type = transparent ? "image/png" : "image/jpeg";
        if ("convertToBlob" in canvas) return await canvas.convertToBlob({ type, quality: 0.8 });
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片预览编码失败")), type, 0.8));
    } finally {
        bitmap?.close();
        if (url) URL.revokeObjectURL(url);
    }
}

// Use bytes already held by an upload; never fetch another original to make a preview.
export function prepareImagePreview(blob: Blob, sourceSize?: ImagePreviewSourceSize): Promise<Blob | null> {
    if (!blob.type.startsWith("image/") || typeof document === "undefined") return Promise.resolve(null);
    if (sourceSize && (!Number.isFinite(sourceSize.width) || !Number.isFinite(sourceSize.height) || sourceSize.width <= 0 || sourceSize.height <= 0)) return Promise.resolve(null);
    const existing = prepared.get(blob);
    if (existing) return existing;
    if (waiting.length >= 64) return Promise.resolve(null);
    const promise = (async () => {
        if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
        else active++;
        try { return await encodePreview(blob, sourceSize); } catch { return null; } finally {
            const next = waiting.shift();
            if (next) next(); else active--;
        }
    })();
    prepared.set(blob, promise);
    return promise;
}
