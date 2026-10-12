import type { AdminModelChannel, AdminSettings, AdminUserGroup } from "@/services/api/admin";
import { isWorkflowProtocol } from "@/lib/model-channel";

export function availableUserGroupModels(settings: AdminSettings): string[] {
    const models = settings.public.modelChannel.availableModels;
    return models.length ? models : [...new Set(settings.private.channels.filter(channel => channel.enabled && !isWorkflowProtocol(channel.protocol)).flatMap(channel => channel.models))];
}

export function normalizeUserGroups(groups: AdminUserGroup[] | undefined, available: string[], saved?: AdminUserGroup[], channels: AdminModelChannel[] = []): AdminUserGroup[] {
    if (groups === undefined) groups = saved;
    if (!groups?.length && !saved?.length) return [{ id: "default", name: "默认用户", unrestricted: true, models: [], isDefault: true, remark: "" }];
    const seen = new Set<string>();
    const allowed = new Set(available);
    const result = (groups || []).filter(group => group.id?.trim()).map(group => {
        const id = group.id.trim();
        if (seen.has(id)) throw new Error("分组 ID 不能重复");
        seen.add(id);
        const original = [...new Set((group.models || []).map(model => model.trim()).filter(Boolean))];
        const models = group.unrestricted ? [] : original.filter(model => allowed.has(model));
        const scopes: NonNullable<AdminUserGroup["scopes"]> = [];
        for (const value of group.unrestricted ? [] : group.scopes || []) {
            const scope = { channelId: value.channelId.trim(), model: value.model.trim() };
            if (!scope.channelId || !scope.model) continue;
            if (!channels.some(channel => channel.id === scope.channelId)) throw new Error("用户分组配置的渠道不存在");
            if (!allowed.has(scope.model)) throw new Error("该分组配置的模型均未开放");
            if (!scopes.some(item => item.channelId === scope.channelId && item.model === scope.model)) scopes.push(scope);
        }
        if (!group.unrestricted && original.length && !models.length && !scopes.length) throw new Error("该分组配置的模型均未开放");
        return { id, name: group.name?.trim() || id, unrestricted: group.unrestricted === true, models, ...(scopes.length ? { scopes } : {}), isDefault: group.isDefault === true, remark: group.remark?.trim() || "" };
    });
    if (result.filter(group => group.isDefault).length !== 1 || !result.some(group => group.id === "default" && group.isDefault)) throw new Error("必须保留唯一默认分组，ID 不可修改");
    if (result.some(group => group.id === "default" && !group.isDefault)) throw new Error("默认分组身份不可修改");
    return result;
}

export function userGroupLabel(id: string | undefined, groups: AdminUserGroup[]) {
    return groups.find(group => group.id === id)?.name || groups.find(group => group.id === "default")?.name || "默认用户";
}
