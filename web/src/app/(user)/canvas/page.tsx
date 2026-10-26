"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { App, Button } from "antd";
import { Download, FileUp, Plus } from "lucide-react";

import { readZip } from "@/lib/zip";
import { CanvasDeleteProjectsDialog } from "./components/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "./components/canvas-project-card";
import type { CanvasExportFile } from "./export-types";
import { useCanvasStore } from "./stores/use-canvas-store";
import { useCanvasUiStore } from "./stores/use-canvas-ui-store";
import { countCanvasCloudAssets, exportCanvasProjects, restoreCanvasExportAsset } from "./utils/canvas-export";

export default function CanvasPage() {
    const { message } = App.useApp();
    const router = useRouter();
    const inputRef = useRef<HTMLInputElement>(null);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const loadProject = useCanvasStore((state) => state.loadProject);
    const syncError = useCanvasStore((state) => state.syncError);
    const retrySaves = useCanvasStore((state) => state.retrySaves);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);

    const enterProject = (id: string) => {
        router.push(`/canvas/${id}`);
    };
    const createAndEnter = () => enterProject(createProject(`无限画布 ${projects.length + 1}`));
    const exportSelected = async () => {
        try {
            const owner = useCanvasStore.getState().ownerUserId;
            const complete = await Promise.all(selectedIds.map(id => loadProject(id)));
            if (owner !== useCanvasStore.getState().ownerUserId) return;
            if (complete.some(project => !project)) throw new Error("部分画布无法加载，请重试");
            const loaded = complete.filter((project): project is NonNullable<typeof project> => Boolean(project));
            const cloudAssetCount = countCanvasCloudAssets(loaded);
            const loadingKey = "canvas-export";
            if (cloudAssetCount) message.loading({ content: `正在导出 ${cloudAssetCount} 个云端素材...`, key: loadingKey, duration: 0 });
            try {
                const result = await exportCanvasProjects(loaded, `无限画布-${selectedIds.length}个项目`);
                if (result.missing.length) {
                    message.warning(
                        `${result.missing.length} 个素材导出失败：${result.missing.map((item) => `${item.storageKey}（${item.reason}）`).join("、")}`,
                    );
                }
            } finally {
                message.destroy(loadingKey);
            }
        } catch (error) { message.error(error instanceof Error ? error.message : "画布导出失败，请重试"); }
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            await Promise.all(
                data.projects.flatMap((project) =>
                    project.files.map(async (item) => {
                        const blob = zip.get(item.path);
                        if (!blob) return;
                        await restoreCanvasExportAsset(item, blob);
                    }),
                ),
            );
            data.projects.forEach((item) => importProject(item.project));
            message.success(`已导入 ${data.projects.length} 个画布`);
        } catch {
            message.error("导入失败，请选择有效的画布压缩包");
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">画布库</p>
                        <h1 className="mt-3 text-3xl font-semibold">无限画布</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportSelected()}>
                                    导出选中
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    删除选中
                                </Button>
                            </>
                        ) : null}
                        {projects.length ? (
                            <Button disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                删除全部
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            导入画布
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </div>
                </header>

                {syncError ? <div role="alert" className="flex items-center gap-3 text-sm"><span>{syncError}</span><Button size="small" onClick={() => void retrySaves()}>重试同步</Button></div> : null}

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">正在加载画布...</section>
                ) : projects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {projects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">还没有画布</h2>
                        <p className="mt-3 text-sm text-stone-500">新建一个画布后，就可以独立保存节点、连线和画布外观。</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
