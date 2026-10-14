"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Modal, Progress } from "antd";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import type { GuestCanvasImportProgress } from "@/lib/guest-canvas-import";

export function GuestCanvasImportPrompt() {
    const { message } = App.useApp();
    const ownerId = useUserStore(state => state.user?.id || "");
    const token = useUserStore(state => state.token);
    const isReady = useUserStore(state => state.isReady);
    const [projects, setProjects] = useState<CanvasProject[]>([]);
    const [open, setOpen] = useState(false);
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<GuestCanvasImportProgress | null>(null);
    const [error, setError] = useState("");
    const [readFailed, setReadFailed] = useState(false);
    const sessionRef = useRef("");
    sessionRef.current = `${ownerId}:${token}`;

    useEffect(() => {
        if (!isReady || !ownerId || !token) return;
        let active = true;
        setOpen(false);
        setRunning(false);
        setProgress(null);
        setError("");
        setReadFailed(false);
        void import("@/services/storage-migration").then(module => module.loadGuestCanvasImportProjects(ownerId, token)).then(items => {
            if (!active || !items.length) return;
            setProjects(items);
            setOpen(true);
        }).catch(failure => {
            if (!active) return;
            setReadFailed(true);
            setError(failure instanceof Error ? failure.message : "读取本地游客画布失败，请重试");
            setOpen(true);
        });
        return () => { active = false; };
    }, [isReady, ownerId, token]);

    const retryRead = async () => {
        const session = `${ownerId}:${token}`;
        setRunning(true);
        try {
            const { loadGuestCanvasImportProjects } = await import("@/services/storage-migration");
            const items = await loadGuestCanvasImportProjects(ownerId, token);
            if (sessionRef.current !== session) return;
            setProjects(items);
            setReadFailed(false);
            setError("");
            if (!items.length) setOpen(false);
        } catch (failure) {
            if (sessionRef.current === session) setError(failure instanceof Error ? failure.message : "读取失败，请重试");
        } finally {
            if (sessionRef.current === session) setRunning(false);
        }
    };

    const importProjects = async () => {
        const session = `${ownerId}:${token}`;
        setRunning(true);
        setError("");
        try {
            const { importAnonymousCanvasProjects } = await import("@/services/storage-migration");
            const result = await importAnonymousCanvasProjects(projects, ownerId, token, value => {
                if (sessionRef.current === session) setProgress(value);
            });
            if (sessionRef.current !== session) return;
            if (result.failed) {
                const failedIds = new Set(result.errors.map(item => item.id));
                setProjects(items => items.filter(item => failedIds.has(item.id)));
                setError(`${result.failed} 个画布未导入：${result.errors.map(item => `${item.title}：${item.message}`).join("；")}`);
            } else {
                setProjects([]);
                setOpen(false);
                message.success(`已导入 ${result.imported} 个画布${result.skipped ? `，${result.skipped} 个已存在` : ""}`);
            }
        } catch (failure) {
            if (sessionRef.current === session) setError(failure instanceof Error ? failure.message : "导入失败，请重试");
        } finally {
            if (sessionRef.current === session) setRunning(false);
        }
    };

    return (
        <Modal
            title="导入游客画布"
            open={open}
            okText={readFailed ? "重新读取" : error ? "重试未完成的画布" : "导入当前账号"}
            cancelText="暂不导入"
            confirmLoading={running}
            closable={!running}
            maskClosable={!running}
            cancelButtonProps={{ disabled: running }}
            onOk={() => void (readFailed ? retryRead() : importProjects())}
            onCancel={() => setOpen(false)}
        >
            <p>{readFailed ? "游客原件尚未修改，请重新读取后确认导入。" : `发现 ${projects.length} 个游客画布。确认后将画布和媒体保存到当前账号，游客原件会保留在本机。`}</p>
            {progress ? <Progress percent={progress.total ? Math.round(progress.completed / progress.total * 100) : 0} status={error ? "exception" : running ? "active" : "normal"} /> : null}
            {running && progress ? <p>正在导入 {progress.completed}/{progress.total} 个画布…</p> : null}
            {error ? <Alert type="warning" showIcon title="导入未完成，可重试" description={error} /> : null}
        </Modal>
    );
}
