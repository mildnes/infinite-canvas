"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Modal, Slider } from "antd";
import { Pause, Play } from "lucide-react";

export type CanvasAudioTrimRange = {
    start: number;
    end: number;
};

type CanvasAudioTrimDialogProps = {
    open: boolean;
    sourceUrl?: string;
    title?: string;
    confirmLoading?: boolean;
    onClose: () => void;
    onConfirm: (range: CanvasAudioTrimRange) => void | Promise<void>;
};

const MIN_AUDIO_TRIM_SECONDS = 0.5;

export function CanvasAudioTrimDialog({ open, sourceUrl, title = "音频", confirmLoading = false, onClose, onConfirm }: CanvasAudioTrimDialogProps) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const rangeRef = useRef<CanvasAudioTrimRange>({ start: 0, end: 0 });
    const [duration, setDuration] = useState(0);
    const [range, setRange] = useState<CanvasAudioTrimRange>({ start: 0, end: 0 });
    const [playing, setPlaying] = useState(false);
    const [loadError, setLoadError] = useState("");
    const tooShort = Math.round((range.end - range.start) * 100) < MIN_AUDIO_TRIM_SECONDS * 100;

    useEffect(() => {
        rangeRef.current = range;
    }, [range]);

    useEffect(() => {
        setPlaying(false);
        setDuration(0);
        setLoadError("");
        setRange({ start: 0, end: 0 });
        rangeRef.current = { start: 0, end: 0 };
        if (!open || !sourceUrl) return;

        const audio = new Audio(sourceUrl);
        audio.preload = "metadata";
        audioRef.current = audio;
        audio.onloadedmetadata = () => {
            const nextDuration = Number.isFinite(audio.duration) ? Math.floor(audio.duration * 100) / 100 : 0;
            setDuration(nextDuration);
            setRange({ start: 0, end: nextDuration });
            rangeRef.current = { start: 0, end: nextDuration };
        };
        audio.onplay = () => setPlaying(true);
        audio.onpause = () => setPlaying(false);
        audio.onended = () => setPlaying(false);
        audio.ontimeupdate = () => {
            if (audio.currentTime >= rangeRef.current.end) audio.pause();
        };
        audio.onerror = () => {
            setLoadError("音频加载失败");
            setPlaying(false);
        };
        audio.load();

        return () => {
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
            if (audioRef.current === audio) audioRef.current = null;
        };
    }, [open, sourceUrl]);

    const updateRange = (value: number | number[]) => {
        if (!Array.isArray(value) || value.length < 2) return;
        const next = { start: Number(value[0]), end: Number(value[1]) };
        if (next.end - next.start < MIN_AUDIO_TRIM_SECONDS) return;
        const audio = audioRef.current;
        audio?.pause();
        if (audio) audio.currentTime = next.start;
        setRange(next);
    };

    const togglePreview = () => {
        const audio = audioRef.current;
        if (!audio || tooShort || confirmLoading) return;
        if (!audio.paused) {
            audio.pause();
            return;
        }
        if (audio.currentTime < range.start || audio.currentTime >= range.end) audio.currentTime = range.start;
        void audio.play().catch((error) => {
            if (error instanceof Error && error.name !== "AbortError") setLoadError("音频试听失败");
        });
    };

    return (
        <Modal
            title={`截取音频${title ? ` · ${title}` : ""}`}
            open={open}
            centered
            width={360}
            confirmLoading={confirmLoading}
            closable={!confirmLoading}
            okText="确认截取"
            cancelText="取消"
            okButtonProps={{ disabled: tooShort || !duration }}
            cancelButtonProps={{ disabled: confirmLoading }}
            onCancel={() => {
                if (!confirmLoading) onClose();
            }}
            onOk={() => {
                if (!tooShort && duration) void onConfirm(range);
            }}
            modalRender={(content) => <div className="select-none" data-canvas-no-zoom>{content}</div>}
        >
            <div className="space-y-4 py-2">
                <Slider
                    {...{ allowCross: false, pushable: MIN_AUDIO_TRIM_SECONDS }}
                    range={{ draggableTrack: true }}
                    min={0}
                    max={duration || 1}
                    step={0.01}
                    value={[range.start, range.end]}
                    disabled={confirmLoading || duration < MIN_AUDIO_TRIM_SECONDS}
                    ariaLabelForHandle={["截取开始时间", "截取结束时间"]}
                    tooltip={{ formatter: (value) => `${(value ?? 0).toFixed(2)} 秒` }}
                    onChange={updateRange}
                />
                <div className="flex justify-between text-xs tabular-nums opacity-60">
                    <span>{range.start.toFixed(2)} 秒</span>
                    <span>选中 {(range.end - range.start).toFixed(2)} 秒</span>
                    <span>{range.end.toFixed(2)} 秒</span>
                </div>
                {loadError ? <div className="text-center text-xs text-red-500">{loadError}</div> : null}
                <div className="flex justify-center">
                    <Button type="text" shape="circle" aria-label={playing ? "暂停" : "播放"} disabled={confirmLoading || tooShort} icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={togglePreview} />
                </div>
            </div>
        </Modal>
    );
}
