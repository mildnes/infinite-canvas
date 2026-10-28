"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import { deleteAdminCreditLog, fetchAdminCreditLogs, saveAdminCreditLog, type AdminCreditLog } from "@/services/api/admin";
import { adminCreditLogListKey, adminLogQueryKeys, adminLogQueryOptions } from "@/lib/admin-log-query";
import { useUserStore } from "@/stores/use-user-store";

const defaultPageSize = 10;

export function useAdminCreditLogs() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const token = useUserStore((state) => state.token);
    const identity = token;
    const clearSession = useUserStore((state) => state.clearSession);
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(defaultPageSize);
    const lastSuccessfulData = useRef<{ identity: string; data: Awaited<ReturnType<typeof fetchAdminCreditLogs>> } | null>(null);

    const query = useQuery({
        queryKey: adminCreditLogListKey(identity, keyword, page, pageSize),
        queryFn: () => fetchAdminCreditLogs(token, { keyword, page, pageSize }),
        enabled: Boolean(token),
        ...adminLogQueryOptions,
        placeholderData: (previousData, previousQuery) => previousQuery?.queryKey[3] === identity ? previousData : undefined,
    });

    const saveMutation = useMutation({
        mutationFn: (log: Partial<AdminCreditLog>) => saveAdminCreditLog(token, log),
        onSuccess: async (_, log) => {
            await queryClient.invalidateQueries({ queryKey: adminLogQueryKeys.creditLists });
            message.success(log.id ? "日志已保存" : "日志已新增");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "保存失败"),
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteAdminCreditLog(token, id),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: adminLogQueryKeys.creditLists });
            message.success("日志已删除");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "删除失败"),
    });

    useEffect(() => {
        if (query.isError) {
            const errorMessage = query.error instanceof Error ? query.error.message : "读取日志失败";
            message.error(errorMessage);
            if (errorMessage.includes("未登录") || errorMessage.includes("权限不足") || errorMessage.includes("登录状态无效")) clearSession();
        }
    }, [clearSession, message, query.error, query.isError]);

    useEffect(() => {
        lastSuccessfulData.current = null;
    }, [identity]);

    useEffect(() => {
        if (query.data) lastSuccessfulData.current = { identity, data: query.data };
    }, [identity, query.data]);

    const updateFilters = (next: Partial<{ keyword: string; page: number; pageSize: number }>) => {
        const queryState = { keyword, page, pageSize, ...next };
        if (next.keyword !== undefined || next.pageSize !== undefined) queryState.page = 1;
        setKeyword(queryState.keyword);
        setPage(queryState.page);
        setPageSize(queryState.pageSize);
    };

    const fallback = query.isError && lastSuccessfulData.current?.identity === identity ? lastSuccessfulData.current.data : null;
    const data = query.data || fallback;

    return {
        logs: data?.items || [],
        keyword,
        page,
        pageSize,
        total: data?.total || 0,
        isLoading: query.isLoading || saveMutation.isPending || deleteMutation.isPending,
        isRefreshing: query.isFetching,
        searchLogs: (value = keyword) => updateFilters({ keyword: value }),
        changePage: (value: number) => updateFilters({ page: value }),
        changePageSize: (value: number) => updateFilters({ pageSize: value }),
        resetFilters: () => updateFilters({ keyword: "", page: 1, pageSize: defaultPageSize }),
        refreshLogs: () => query.refetch(),
        saveLog: (log: Partial<AdminCreditLog>) => saveMutation.mutateAsync(log),
        deleteLog: (id: string) => deleteMutation.mutateAsync(id),
    };
}
