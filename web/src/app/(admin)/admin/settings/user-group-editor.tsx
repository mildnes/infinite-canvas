import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Card, Flex, Input, Popconfirm, Select, Switch, Tag, Typography } from "antd";
import type { AdminUserGroup } from "@/services/api/admin";

export function UserGroupEditor({ groups, models, onChange }: { groups: AdminUserGroup[]; models: string[]; onChange: (groups: AdminUserGroup[]) => void }) {
    const update = (index: number, patch: Partial<AdminUserGroup>) => onChange(groups.map((group, i) => i === index ? { ...group, ...patch } : group));
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
                <Flex gap={8} align="center"><Switch aria-label="不限制模型" checked={group.unrestricted} onChange={unrestricted => update(index, { unrestricted, ...(unrestricted ? { models: [] } : {}) })} /><Typography.Text>不限制（全量）</Typography.Text></Flex>
                {!group.unrestricted ? <Select mode="multiple" aria-label="分组允许模型" placeholder="白名单为空 = 无可用模型" value={group.models} options={models.map(value => ({ value, label: value }))} onChange={values => update(index, { models: values })} /> : null}
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
