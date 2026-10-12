"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import { adjustAdminUserCredits, deleteAdminUser, fetchAdminSettings, fetchAdminUsers, saveAdminUser, type AdminUser } from "@/services/api/admin";
import { availableUserGroupModels, normalizeUserGroups } from "@/lib/user-groups";
import { useUserStore } from "@/stores/use-user-store";

const defaultPageSize = 10;

export function useAdminUsers() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const token = useUserStore((state) => state.token);
    const clearSession = useUserStore((state) => state.clearSession);
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(defaultPageSize);

    const query = useQuery({
        queryKey: ["admin", "users", token, keyword, page, pageSize],
        queryFn: () => fetchAdminUsers(token, { keyword, page, pageSize }),
        enabled: Boolean(token),
        retry: false,
    });
    const groupsQuery = useQuery({
        queryKey: ["admin", "user-groups", token],
        queryFn: async () => {
            const settings = await fetchAdminSettings(token);
            return normalizeUserGroups(settings.public.modelChannel.userGroups, availableUserGroupModels(settings), undefined, settings.private.channels);
        },
        enabled: Boolean(token), retry: false,
    });
    const groupMutation = useMutation({
        mutationFn: async ({ ids, groupId }: { ids: string[]; groupId: string }) => {
            const failures: string[] = [];
            for (const id of ids) {
                try { await saveAdminUser(token, { id, groupId, groupOnly: true }); }
                catch (error) { failures.push(error instanceof Error ? error.message : "保存失败"); }
            }
            if (failures.length) throw new Error(failures.length + " 个用户分组设置失败：" + failures[0]);
        },
        onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
        onSuccess: () => message.success("用户分组已更新"),
        onError: error => message.error(error instanceof Error ? error.message : "分组设置失败"),
    });

    const saveMutation = useMutation({
        mutationFn: (user: Partial<AdminUser> & { password?: string }) => saveAdminUser(token, user),
        onSuccess: async (_, user) => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
            message.success(user.id ? "用户已保存" : "用户已新增");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "保存失败"),
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteAdminUser(token, id),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
            message.success("用户已删除");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "删除失败"),
    });

    const creditMutation = useMutation({
        mutationFn: ({ id, credits }: { id: string; credits: number }) => adjustAdminUserCredits(token, id, credits),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
            message.success("算力点已调整");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "调整失败"),
    });

    useEffect(() => {
        if (query.isError) {
            const errorMessage = query.error instanceof Error ? query.error.message : "读取用户失败";
            message.error(errorMessage);
            if (errorMessage.includes("未登录") || errorMessage.includes("权限不足") || errorMessage.includes("登录状态无效")) clearSession();
        }
    }, [clearSession, message, query.error, query.isError]);

    const updateFilters = (next: Partial<{ keyword: string; page: number; pageSize: number }>) => {
        const queryState = { keyword, page, pageSize, ...next };
        if (next.keyword !== undefined || next.pageSize !== undefined) queryState.page = 1;
        setKeyword(queryState.keyword);
        setPage(queryState.page);
        setPageSize(queryState.pageSize);
    };

    const data = query.data;

    return {
        groups: groupsQuery.data || [],
        setUserGroups: (ids: string[], groupId: string) => groupMutation.mutateAsync({ ids, groupId }),
        users: data?.items || [],
        keyword,
        page,
        pageSize,
        total: data?.total || 0,
        isLoading: query.isFetching || saveMutation.isPending || deleteMutation.isPending || creditMutation.isPending || groupMutation.isPending,
        searchUsers: (value = keyword) => updateFilters({ keyword: value }),
        changePage: (value: number) => updateFilters({ page: value }),
        changePageSize: (value: number) => updateFilters({ pageSize: value }),
        resetFilters: () => updateFilters({ keyword: "", page: 1, pageSize: defaultPageSize }),
        refreshUsers: () => query.refetch(),
        saveUser: (user: Partial<AdminUser> & { password?: string }) => saveMutation.mutateAsync(user),
        adjustCredits: (id: string, credits: number) => creditMutation.mutateAsync({ id, credits }),
        deleteUser: (id: string) => deleteMutation.mutateAsync(id),
    };
}
