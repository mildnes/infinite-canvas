import { App } from "antd";

import { createCanvasProjectExportTicket } from "@/services/api/canvas-tasks";
import { useUserStore } from "@/stores/use-user-store";
import { flushCanvasSaves, useCanvasStore } from "../stores/use-canvas-store";

export function useCanvasProjectExport() {
    const { message } = App.useApp();

    return async (projectIds: string[]) => {
        const { token, user } = useUserStore.getState();
        if (!token || !user?.id || !projectIds.length) return false;
        const ownerId = user.id;
        const assertOwner = () => {
            if (useUserStore.getState().user?.id !== ownerId || !useUserStore.getState().token) {
                throw new Error("登录账号已变化，已取消导出");
            }
        };
        const hasPendingSave = () => useCanvasStore.getState().projects.some(project => projectIds.includes(project.id) && project.pendingSave);
        if (hasPendingSave()) {
            await flushCanvasSaves();
            assertOwner();
            if (hasPendingSave()) {
                message.info("画板尚未同步，已使用兼容模式导出");
                return false;
            }
        }

        const downloads: string[] = [];
        for (const id of [...new Set(projectIds)]) {
            assertOwner();
            let ticket: { url: string; expiresAt: string };
            try {
                ticket = await createCanvasProjectExportTicket(useUserStore.getState().token, id);
            } catch (error) {
                assertOwner();
                const status = (error as { status?: number })?.status;
                if (status === undefined || status === 404 || status === 501) {
                    message.info("已使用兼容模式导出");
                    return false;
                }
                throw error;
            }
            assertOwner();
            const url = new URL(ticket.url, window.location.origin);
            if (url.origin !== window.location.origin || url.pathname !== `/api/v1/canvas/projects/${encodeURIComponent(id)}/export` || !url.searchParams.get("ticket")) {
                throw new Error("导出票据地址无效，请重试");
            }
            downloads.push(url.href);
        }

        assertOwner();
        if (downloads.length > 1) message.info(`将分别下载 ${downloads.length} 个画板压缩包`);
        for (const url of downloads) {
            const link = document.createElement("a");
            link.href = url;
            link.download = "";
            document.body.appendChild(link);
            link.click();
            link.remove();
        }
        message.info("下载已开始；如有素材缺失，请查看压缩包内的 missing.json");
        return true;
    };
}
