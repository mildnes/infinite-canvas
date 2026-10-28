import type { QueryClient } from "@tanstack/react-query";

export const adminLogQueryOptions = {
    staleTime: 30_000,
    gcTime: 300_000,
    retry: false,
} as const;

export const adminLogDetailQueryOptions = {
    staleTime: 300_000,
    gcTime: 300_000,
    retry: false,
} as const;

export const adminLogQueryKeys = {
    aiLists: ["admin", "ai-logs", "list"] as const,
    aiDetails: ["admin", "ai-logs", "detail"] as const,
    creditLists: ["admin", "credit-logs", "list"] as const,
};

export function adminAILogListKey(identity: string, keyword: string, page: number, pageSize: number) {
    return [...adminLogQueryKeys.aiLists, identity, keyword, page, pageSize] as const;
}

export function adminAILogDetailKey(identity: string, id: string) {
    return [...adminLogQueryKeys.aiDetails, identity, id] as const;
}

export function adminCreditLogListKey(identity: string, keyword: string, page: number, pageSize: number) {
    return [...adminLogQueryKeys.creditLists, identity, keyword, page, pageSize] as const;
}

export function clearAdminLogQueries(queryClient: QueryClient, keepIdentity = "") {
    const predicate = (query: { queryKey: readonly unknown[] }) => {
        const [scope, family] = query.queryKey;
        if (scope !== "admin" || (family !== "ai-logs" && family !== "credit-logs")) return false;
        return !keepIdentity || query.queryKey[3] !== keepIdentity;
    };
    void queryClient.cancelQueries({ predicate });
    queryClient.removeQueries({ predicate });
}
