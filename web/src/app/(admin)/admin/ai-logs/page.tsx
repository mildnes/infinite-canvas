"use client";

import { DeleteOutlined, EyeOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Flex, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import {
    adminAILogDetailKey,
    adminAILogListKey,
    adminLogDetailQueryOptions,
    adminLogQueryKeys,
    adminLogQueryOptions,
} from "@/lib/admin-log-query";
import {
    deleteAdminAICallLogs,
    fetchAdminAICallLog,
    fetchAdminAICallLogs,
    fetchAdminSettings,
    saveAdminSettings,
    type AdminAICallLogSummary,
} from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

type LogDetailKind = "request" | "response";
type LogDetail = { identity: string; id: string; kind: LogDetailKind };

export default function AdminAICallLogsPage() {
    const token = useUserStore((state) => state.token);
    const identity = token;
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [draftKeyword, setDraftKeyword] = useState("");
    const [filters, setFilters] = useState({ keyword: "", page: 1, pageSize: 20 });
    const [clearDays, setClearDays] = useState(7);
    const [clearing, setClearing] = useState(false);
    const [detail, setDetail] = useState<LogDetail | null>(null);
    const [localDirectReportEnabled, setLocalDirectReportEnabled] = useState(false);
    const [savingLocalDirectReport, setSavingLocalDirectReport] = useState(false);
    const lastSuccessfulLogs = useRef<{ identity: string; data: { items: AdminAICallLogSummary[]; total: number } } | null>(null);

    const logsQuery = useQuery({
        queryKey: adminAILogListKey(identity, filters.keyword, filters.page, filters.pageSize),
        queryFn: () => fetchAdminAICallLogs(token, filters),
        enabled: Boolean(token),
        ...adminLogQueryOptions,
        placeholderData: (previousData, previousQuery) => previousQuery?.queryKey[3] === identity ? previousData : undefined,
    });
    const activeDetail = detail?.identity === identity ? detail : null;
    const detailId = activeDetail?.id || "";
    const detailQuery = useQuery({
        queryKey: adminAILogDetailKey(identity, detailId),
        queryFn: () => fetchAdminAICallLog(token, detailId),
        enabled: Boolean(token && detailId),
        ...adminLogDetailQueryOptions,
    });

    useEffect(() => {
        let canceled = false;
        if (!token) {
            setLocalDirectReportEnabled(false);
            return () => {
                canceled = true;
            };
        }
        fetchAdminSettings(token)
            .then((settings) => {
                if (!canceled && useUserStore.getState().token === token) {
                    setLocalDirectReportEnabled(settings.private.aiLog?.localDirectReportEnabled === true);
                }
            })
            .catch(() => undefined);
        return () => {
            canceled = true;
        };
    }, [token]);

    useEffect(() => {
        lastSuccessfulLogs.current = null;
        setDetail(null);
    }, [identity]);

    useEffect(() => {
        if (logsQuery.data) lastSuccessfulLogs.current = { identity, data: logsQuery.data };
    }, [identity, logsQuery.data]);

    const submitFilters = (keyword: string) => setFilters((current) => ({ keyword, page: 1, pageSize: current.pageSize }));

    const clearLogs = async () => {
        if (!token) return;
        setClearing(true);
        try {
            const result = await deleteAdminAICallLogs(token, clearDays);
            if (useUserStore.getState().token !== token) return;
            message.success(`已清理 ${result.removedFiles} 个日志文件`);
            setDetail(null);
            setFilters((current) => ({ ...current, page: 1 }));
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: adminLogQueryKeys.aiLists, refetchType: "none" }),
                queryClient.invalidateQueries({ queryKey: adminLogQueryKeys.aiDetails, refetchType: "none" }),
            ]);
            if (filters.page === 1) await logsQuery.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "清理 AI 调用日志失败");
        } finally {
            setClearing(false);
        }
    };

    const updateLocalDirectReport = async (checked: boolean) => {
        if (!token) return;
        const previous = localDirectReportEnabled;
        setLocalDirectReportEnabled(checked);
        setSavingLocalDirectReport(true);
        try {
            const settings = await fetchAdminSettings(token);
            await saveAdminSettings(token, {
                ...settings,
                private: {
                    ...settings.private,
                    aiLog: {
                        ...settings.private.aiLog,
                        localDirectReportEnabled: checked,
                    },
                },
            });
            message.success(checked ? "已开启本地直连日志上报" : "已关闭本地直连日志上报");
        } catch (error) {
            setLocalDirectReportEnabled(previous);
            message.error(error instanceof Error ? error.message : "保存本地直连日志设置失败");
        } finally {
            setSavingLocalDirectReport(false);
        }
    };

    const columns = useMemo(
        () => [
            { title: "时间", dataIndex: "createdAt", width: 170, render: (value: string) => formatTime(value) },
            { title: "用户", dataIndex: "userDisplayName", width: 150, render: (_: string, item: AdminAICallLogSummary) => item.userDisplayName || item.userId || "-" },
            { title: "接口", dataIndex: "endpoint", width: 170 },
            { title: "模型", dataIndex: "model", width: 180, ellipsis: true },
            { title: "渠道", dataIndex: "channelName", width: 150, ellipsis: true, render: (_: string, item: AdminAICallLogSummary) => item.channelName || item.channelId || "-" },
            { title: "状态", dataIndex: "status", width: 90, render: (status: number) => <Tag color={status >= 200 && status < 400 ? "success" : "error"}>{status || "失败"}</Tag> },
            { title: "耗时", dataIndex: "durationMs", width: 110, render: (value: number) => formatDuration(value) },
            { title: "扣点", dataIndex: "credits", width: 80 },
            {
                title: "操作",
                key: "actions",
                width: 180,
                fixed: "right" as const,
                render: (_: unknown, item: AdminAICallLogSummary) => (
                    <Space size={6}>
                        <Button size="small" icon={<EyeOutlined />} onClick={() => setDetail({ identity, id: item.id, kind: "request" })}>
                            请求详情
                        </Button>
                        <Button size="small" icon={<EyeOutlined />} onClick={() => setDetail({ identity, id: item.id, kind: "response" })}>
                            返回详情
                        </Button>
                    </Space>
                ),
            },
        ],
        [identity],
    );

    const fallback = logsQuery.isError && lastSuccessfulLogs.current?.identity === identity ? lastSuccessfulLogs.current.data : null;
    const data = logsQuery.data || fallback;
    const logs = data?.items || [];
    const total = data?.total || 0;
    const detailValue = detailQuery.data
        ? activeDetail?.kind === "request"
            ? detailQuery.data.requestBody
            : detailQuery.data.responseBody || detailQuery.data.error
        : "";

    return (
        <main className="p-3 md:p-6">
            <Flex vertical gap={16} className="w-full">
                <Card variant="borderless">
                    <Form layout="vertical" onFinish={() => submitFilters(draftKeyword)}>
                        <div className="flex flex-wrap items-center gap-3">
                            <Input className="min-w-[280px] flex-1 lg:max-w-[460px]" value={draftKeyword} placeholder="搜索用户、模型、渠道、接口或错误" onChange={(event) => setDraftKeyword(event.target.value)} />
                            <Button htmlType="submit" type="primary" icon={<SearchOutlined />}>
                                查询
                            </Button>
                            <Button icon={<ReloadOutlined />} onClick={() => { setDraftKeyword(""); submitFilters(""); }}>
                                重置
                            </Button>
                            <Button icon={<ReloadOutlined />} loading={logsQuery.isFetching} onClick={() => void logsQuery.refetch()}>
                                刷新
                            </Button>
                            <div className="flex h-8 items-center gap-2 rounded-md border border-stone-200 px-3 dark:border-stone-800">
                                <Typography.Text className="whitespace-nowrap text-sm">本地直连日志</Typography.Text>
                                <Switch size="small" checked={localDirectReportEnabled} loading={savingLocalDirectReport} onChange={(checked) => void updateLocalDirectReport(checked)} />
                            </div>
                            <div className="flex h-8 items-center gap-2">
                                <Typography.Text className="whitespace-nowrap text-sm">清理超过</Typography.Text>
                                <InputNumber min={1} value={clearDays} className="!w-24" onChange={(value) => setClearDays(Number(value) || 7)} />
                                <Typography.Text type="secondary" className="shrink-0">天前</Typography.Text>
                            </div>
                            <Button danger icon={<DeleteOutlined />} loading={clearing} onClick={() => void clearLogs()} className="ml-0 lg:ml-auto">
                                清理旧日志
                            </Button>
                        </div>
                    </Form>
                </Card>
                {logsQuery.isError ? <Alert showIcon type="error" message="AI 调用日志刷新失败" description={logsQuery.error instanceof Error ? logsQuery.error.message : "请稍后重试"} /> : null}
                <Card variant="borderless" title={<span>AI 调用日志 <Tag>{total} 条</Tag></span>}>
                    <Table
                        rowKey="id"
                        size="small"
                        loading={logsQuery.isLoading}
                        columns={columns}
                        dataSource={logs}
                        scroll={{ x: 1280 }}
                        pagination={{
                            current: filters.page,
                            pageSize: filters.pageSize,
                            total,
                            showSizeChanger: true,
                            onChange: (page, pageSize) =>
                                setFilters((current) => ({
                                    ...current,
                                    page: pageSize !== current.pageSize ? 1 : page,
                                    pageSize,
                                })),
                        }}
                    />
                </Card>
            </Flex>
            <Modal
                title={activeDetail?.kind === "request" ? "请求详情" : "返回详情"}
                open={Boolean(activeDetail)}
                width="min(1100px, 92vw)"
                footer={null}
                onCancel={() => setDetail(null)}
                destroyOnHidden
            >
                {detailQuery.isError && !detailQuery.data ? (
                    <Alert
                        showIcon
                        type="error"
                        message="读取日志详情失败"
                        description={detailQuery.error instanceof Error ? detailQuery.error.message : "请稍后重试"}
                        action={<Button size="small" onClick={() => void detailQuery.refetch()}>重试</Button>}
                    />
                ) : (
                    <>
                        {detailQuery.isError ? (
                            <Alert
                                showIcon
                                type="error"
                                message="刷新日志详情失败，已保留上次内容"
                                description={detailQuery.error instanceof Error ? detailQuery.error.message : "请稍后重试"}
                                action={<Button size="small" onClick={() => void detailQuery.refetch()}>重试</Button>}
                            />
                        ) : null}
                        <LogBlock value={detailValue} loading={detailQuery.isLoading} />
                    </>
                )}
            </Modal>
        </main>
    );
}

function LogBlock({ value, loading }: { value: string; loading: boolean }) {
    return (
        <pre className="max-h-[72vh] whitespace-pre-wrap break-words overflow-auto rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-5 text-stone-700 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-200">
            {loading ? "加载中..." : value || "-"}
        </pre>
    );
}

function formatTime(value: string) {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(value: number) {
    if (!Number.isFinite(value) || value <= 0) return "-";
    return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value}ms`;
}
