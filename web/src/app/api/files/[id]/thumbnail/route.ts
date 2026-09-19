import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const THUMBNAIL_RECIPE_VERSION = "v1-480-webp";
const THUMBNAIL_MAX_EDGE = 480;
const THUMBNAIL_CACHE_LIMIT_BYTES = 512 * 1024 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

type RouteContext = {
    params: Promise<{ id: string }>;
};

class ThumbnailError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

const inFlight = new Map<string, Promise<Buffer>>();
let prunePromise: Promise<void> | null = null;
let nextPruneAt = 0;

function apiBaseURL() {
    return (process.env.API_BASE_URL?.trim() || "http://127.0.0.1:8080").replace(/\/$/, "");
}

function internalURL(id: string, suffix: string) {
    return `${apiBaseURL()}/api/files/${encodeURIComponent(id)}${suffix}`;
}

function cacheDirectory() {
    const configured = process.env.THUMBNAIL_CACHE_DIR?.trim();
    if (configured) return configured;
    const dataDirectory = process.env.APP_DATA_DIR?.trim() || "/app/data";
    return join(dataDirectory, "thumbnail-cache");
}

function cacheKey(id: string) {
    return createHash("sha256")
        .update(`${THUMBNAIL_RECIPE_VERSION}\0${id}`)
        .digest("hex");
}

function cachePath(id: string) {
    return join(cacheDirectory(), `${THUMBNAIL_RECIPE_VERSION}-${cacheKey(id)}.webp`);
}

async function readLimitedBody(response: Response) {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
        throw new ThumbnailError(413, "原图超过缩略图处理大小限制");
    }
    if (!response.body) throw new ThumbnailError(502, "原图响应为空");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > MAX_SOURCE_BYTES) {
                await reader.cancel();
                throw new ThumbnailError(413, "原图超过缩略图处理大小限制");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const result = Buffer.allocUnsafe(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

async function loadOriginal(id: string) {
    const response = await fetch(internalURL(id, "/content"), {
        cache: "no-store",
        redirect: "manual",
        headers: { Accept: "image/*" },
    });
    if (!response.ok) {
        throw new ThumbnailError(response.status === 404 ? 404 : 502, "原图读取失败");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "";
    if (!contentType.startsWith("image/")) {
        throw new ThumbnailError(415, "该对象不是可处理的图片");
    }
    return readLimitedBody(response);
}

async function renderThumbnail(id: string) {
    const input = await loadOriginal(id);
    return sharp(input, { failOn: "error" })
        .rotate()
        .resize({
            width: THUMBNAIL_MAX_EDGE,
            height: THUMBNAIL_MAX_EDGE,
            fit: "inside",
            withoutEnlargement: true,
        })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
}

async function ensureCacheDirectory() {
    try {
        await mkdir(cacheDirectory(), { recursive: true, mode: 0o700 });
        return true;
    } catch (error) {
        console.warn("Thumbnail cache is unavailable; serving uncached thumbnails", error);
        return false;
    }
}

async function readCachedThumbnail(path: string) {
    try {
        const data = await readFile(path);
        const now = new Date();
        void utimes(path, now, now).catch(() => undefined);
        return data;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        console.warn("Thumbnail cache read failed; regenerating thumbnail", error);
        return null;
    }
}

async function writeCachedThumbnail(path: string, data: Buffer) {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, data, { mode: 0o600 });
        await rename(temporaryPath, path);
    } finally {
        await unlink(temporaryPath).catch(() => undefined);
    }
}

async function pruneThumbnailCache() {
    try {
        const entries = await readdir(cacheDirectory(), { withFileTypes: true });
        const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
        let total = 0;
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".webp")) continue;
            const path = join(cacheDirectory(), entry.name);
            try {
                const info = await stat(path);
                files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
                total += info.size;
            } catch {
                // A concurrent request may have replaced or removed this entry.
            }
        }
        if (total <= THUMBNAIL_CACHE_LIMIT_BYTES) return;
        files.sort((left, right) => left.mtimeMs - right.mtimeMs);
        for (const file of files) {
            if (total <= THUMBNAIL_CACHE_LIMIT_BYTES) break;
            await unlink(file.path).catch(() => undefined);
            total -= file.size;
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn("Thumbnail cache prune failed", error);
        }
    }
}

function schedulePrune() {
    if (prunePromise || Date.now() < nextPruneAt) return prunePromise || Promise.resolve();
    nextPruneAt = Date.now() + 60 * 60 * 1000;
    prunePromise = pruneThumbnailCache().finally(() => {
        prunePromise = null;
    });
    return prunePromise;
}

async function getThumbnail(id: string, useCache: boolean) {
    const key = cacheKey(id);
    const path = cachePath(id);
    if (useCache) {
        const cached = await readCachedThumbnail(path);
        if (cached) {
            void schedulePrune().catch(() => undefined);
            return { data: cached, cacheStatus: "HIT" };
        }
    }

    const existing = inFlight.get(key);
    if (existing) return { data: await existing, cacheStatus: "COALESCED" };

    const pending = renderThumbnail(id);
    inFlight.set(key, pending);
    try {
        const data = await pending;
        if (useCache) {
            try {
                await writeCachedThumbnail(path, data);
            } catch (error) {
                console.warn("Thumbnail cache write failed; serving generated thumbnail", error);
            }
            void schedulePrune().catch(() => undefined);
        }
        return { data, cacheStatus: "MISS" };
    } finally {
        inFlight.delete(key);
    }
}

function failureResponse(error: unknown) {
    const status = error instanceof ThumbnailError ? error.status : 502;
    return Response.json({ code: 1, data: null, msg: "缩略图暂时不可用" }, {
        status,
        headers: { "Cache-Control": "no-store" },
    });
}

export async function GET(_request: Request, context: RouteContext) {
    const { id: rawID } = await context.params;
    const id = rawID.trim();
    if (!id || id.length > 128 || id.includes("/") || id.includes("\\") || id.includes("..")) {
        return failureResponse(new ThumbnailError(400, "对象 ID 无效"));
    }

    try {
        const useCache = await ensureCacheDirectory();
        const result = await getThumbnail(id, useCache);
        return new Response(result.data, {
            status: 200,
            headers: {
                "Content-Type": "image/webp",
                "Content-Length": String(result.data.byteLength),
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Thumbnail-Cache": result.cacheStatus,
            },
        });
    } catch (error) {
        console.warn("Thumbnail request failed", id, error);
        return failureResponse(error);
    }
}
