"use client";

import { downloadRemoteMedia, resolveMediaUrl } from "@/services/file-storage";

export type CanvasAudioTrim = {
    start: number;
    end: number;
};

export type ExtractCanvasAudioOptions = {
    content?: string;
    storageKey?: string;
    title?: string;
    trim?: CanvasAudioTrim;
};

/**
 * Decode the primary audio track from a canvas media node into a WAV file.
 *
 * The heavy decoder stays out of the initial canvas bundle: mediabunny is
 * imported only after the user starts extraction. Resolving the media URL and
 * loading the decoder happen in parallel because neither depends on the other.
 */
export async function extractCanvasAudioFile({ content, storageKey, title, trim }: ExtractCanvasAudioOptions): Promise<File> {
    if (trim && (!Number.isFinite(trim.start) || !Number.isFinite(trim.end) || trim.start < 0 || trim.end <= trim.start || Math.round((trim.end - trim.start) * 100) < 50)) {
        throw new Error("请填写有效的起止时间，至少保留 0.5 秒");
    }

    const mediaBlobPromise = resolveMediaUrl(storageKey, content || "").then((sourceUrl) => {
        if (!sourceUrl) throw new Error("找不到可处理的媒体");
        return downloadRemoteMedia(sourceUrl);
    });
    let input: import("mediabunny").Input | undefined;
    let conversion: import("mediabunny").Conversion | undefined;

    try {
        const [{ Input, ALL_FORMATS, BlobSource, Output, WavOutputFormat, BufferTarget, Conversion }, blob] = await Promise.all([
            import("mediabunny"),
            mediaBlobPromise,
        ]);
        input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
        const audioTrack = await input.getPrimaryAudioTrack();
        if (!audioTrack) throw new Error("该文件没有音轨");

        const duration = await audioTrack.computeDuration();
        if (trim && trim.end > duration) throw new Error("结束时间不能超过音频时长");

        const target = new BufferTarget();
        const output = new Output({ format: new WavOutputFormat(), target });
        conversion = await Conversion.init({
            input,
            output,
            tracks: "primary",
            trim,
            audio: {
                process: (sample) => {
                    if (sample.timestamp < 0 && sample.timestamp > -1e-9) sample.setTimestamp(0);
                    return sample;
                },
            },
        });
        if (!conversion.isValid) throw new Error("当前浏览器无法解码该文件的音频");
        await conversion.execute();
        if (!target.buffer) throw new Error("音频转换没有产生有效文件");

        const baseName = title?.trim() || (trim ? "音频" : "视频");
        return new File([target.buffer], `${baseName} ${trim ? "截取" : "音频"}.wav`, { type: "audio/wav" });
    } finally {
        await conversion?.cancel().catch(() => undefined);
        input?.dispose();
    }
}
