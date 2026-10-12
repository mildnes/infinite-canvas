import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Card, Flex, Input, Popconfirm, Select, Switch, Table, Tag, Typography } from "antd";
import type { AdminModelChannel, AdminUserGroup } from "@/services/api/admin";
import { isWorkflowProtocol } from "@/lib/model-channel";

type ScopeRow = { channelId: string; models: string[] };

export function userGroupScopeRows(scopes: AdminUserGroup["scopes"]): ScopeRow[] {
    const rows: ScopeRow[] = [];
    for (const scope of scopes || []) {
        let row = scope.channelId ? rows.find(row => row.channelId === scope.channelId) : undefined;
        if (!row) { row = { channelId: scope.channelId, models: [] }; rows.push(row); }
        if (scope.model && !row.models.includes(scope.model)) row.models.push(scope.model);
    }
    return rows;
}

export function userGroupScopesFromRows(rows: ScopeRow[]): NonNullable<AdminUserGroup["scopes"]> {
    // Empty rows are editor drafts only; normalization drops them before saving.
    return rows.flatMap(row => row.models.length ? row.models.map(model => ({ channelId: row.channelId, model })) : [{ channelId: row.channelId, model: "" }]);
}

export function convertUserGroupNamesToScopes(group: AdminUserGroup, channels: AdminModelChannel[], models: string[]): AdminUserGroup {
    const scopes = [...(group.scopes || [])];
    for (const channel of channels.filter(channel => channel.enabled && !isWorkflowProtocol(channel.protocol))) {
        for (const model of group.models) {
            if (models.includes(model) && channel.models.includes(model) && !scopes.some(scope => scope.channelId === channel.id && scope.model === model)) scopes.push({ channelId: channel.id, model });
        }
    }
    return { ...group, models: [], scopes };
}

export function UserGroupEditor({ groups, models, channels = [], onChange }: { groups: AdminUserGroup[]; models: string[]; channels?: AdminModelChannel[]; onChange: (groups: AdminUserGroup[]) => void }) {
    const update = (index: number, patch: Partial<AdminUserGroup>) => onChange(groups.map((group, i) => i === index ? { ...group, ...patch } : group));
    const enabledChannels = channels.filter(channel => channel.enabled && !isWorkflowProtocol(channel.protocol));
    const whitelist = (group: AdminUserGroup, index: number) => {
        const rows = userGroupScopeRows(group.scopes);
        const updateRows = (next: ScopeRow[]) => update(index, { scopes: userGroupScopesFromRows(next) });
        return <Flex vertical gap={8}>
            <Table<ScopeRow>
                size="small" pagination={false} rowKey={(_, rowIndex) => String(rowIndex)} dataSource={rows} scroll={{ x: 620 }}
                locale={{ emptyText: "白名单为空 = 该组无任何可用模型" }}
                columns={[
                    { title: "渠道", width: 210, render: (_, row, rowIndex) => <Select aria-label="分组渠道" placeholder="选择渠道" value={row.channelId || undefined} showSearch={{ optionFilterProp: ["label", "value"] }} style={{ width: "100%" }} options={enabledChannels.map(channel => ({ value: channel.id, label: channel.name || channel.id, disabled: rows.some((item, i) => i !== rowIndex && item.channelId === channel.id) }))} onChange={channelId => updateRows(rows.map((item, i) => i === rowIndex ? { channelId, models: [] } : item))} /> },
                    { title: "该渠道允许的模型", render: (_, row, rowIndex) => <Select mode="multiple" aria-label="该渠道允许的模型" placeholder="选择该渠道的模型（多选）" disabled={!row.channelId} value={row.models} showSearch={{ optionFilterProp: ["label", "value"] }} style={{ width: "100%" }} options={(enabledChannels.find(channel => channel.id === row.channelId)?.models || []).filter(model => models.includes(model)).map(value => ({ value, label: value }))} onChange={values => updateRows(rows.map((item, i) => i === rowIndex ? { ...item, models: values } : item))} /> },
                    { title: "操作", width: 60, render: (_, _row, rowIndex) => <Button type="text" danger icon={<DeleteOutlined />} aria-label="删除渠道范围" onClick={() => updateRows(rows.filter((_, i) => i !== rowIndex))} /> },
                ]}
            />
            <Button type="dashed" icon={<PlusOutlined />} onClick={() => updateRows([...rows, { channelId: "", models: [] }])}>添加渠道范围</Button>
            {group.models.length ? <Flex vertical gap={6} aria-label="分组允许模型">
                <Flex gap={8} align="center" wrap><Typography.Text type="secondary">旧格式（按名称，不限渠道）：</Typography.Text><Button type="link" size="small" onClick={() => update(index, convertUserGroupNamesToScopes(group, enabledChannels, models))}>一键转为按渠道</Button></Flex>
                <Flex gap={4} wrap>{group.models.map(model => <Tag key={model} closable onClose={() => update(index, { models: group.models.filter(value => value !== model) })}>{model}</Tag>)}</Flex>
            </Flex> : null}
        </Flex>;
    };
    return <Flex vertical gap={12}>
        <Typography.Text type="secondary">分组仅约束系统渠道模型；不限制 = 可用全部系统模型，白名单为空 = 该组无任何可用模型。计费不变。</Typography.Text>
        {groups.map((group, index) => <Card key={index} size="small" title={<Flex gap={8} align="center"><Typography.Text>{group.name || "未命名分组"}</Typography.Text>{group.isDefault ? <Tag>默认分组</Tag> : null}</Flex>} extra={group.isDefault
            ? <Button type="text" danger disabled icon={<DeleteOutlined />} title="内置默认分组不可删除" />
            : <Popconfirm title="删除分组？成员将回落默认分组" onConfirm={() => onChange(groups.filter((_, i) => i !== index))}><Button type="text" danger icon={<DeleteOutlined />} aria-label="删除分组" /></Popconfirm>}>
            <Flex vertical gap={10}>
                <Flex gap={8} wrap>
                    <Input aria-label="分组 ID" placeholder="分组 ID" disabled={group.isDefault} value={group.id} onChange={event => update(index, { id: event.target.value })} style={{ flex: "1 1 160px" }} />
                    <Input aria-label="分组名称" placeholder="分组名称" value={group.name} onChange={event => update(index, { name: event.target.value })} style={{ flex: "1 1 200px" }} />
                </Flex>
                <Flex gap={8} align="center"><Switch aria-label="不限制模型" checked={group.unrestricted} onChange={unrestricted => update(index, { unrestricted, ...(unrestricted ? { models: [], scopes: [] } : {}) })} /><Typography.Text>不限制（全量）</Typography.Text></Flex>
                {!group.unrestricted ? whitelist(group, index) : null}
                <Input aria-label="分组备注" placeholder="备注" value={group.remark} onChange={event => update(index, { remark: event.target.value })} />
            </Flex>
        </Card>)}
        <Button icon={<PlusOutlined />} type="dashed" onClick={() => {
            let id = "group-" + (groups.length + 1);
            while (groups.some(group => group.id === id)) id += "1";
            onChange([...groups, { id, name: "新分组", unrestricted: false, models: [], isDefault: false, remark: "" }]);
        }}>添加分组</Button>
    </Flex>;
}
