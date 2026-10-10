import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { AutoComplete, Button, Table, Typography } from "antd";
import type { AdminModelChannel } from "@/services/api/admin";

export type ModelMappingRow = { id: number; requestName: string; upstreamName: string };

export function emptyModelMappingRow(rows: ModelMappingRow[], requestName = "", upstreamName = ""): ModelMappingRow {
    return { id: Math.max(0, ...rows.map((item) => item.id)) + 1, requestName, upstreamName };
}

export function buildModelMappingRows(channel: Partial<AdminModelChannel> = {}, upstreamModels: string[] = []): ModelMappingRow[] {
    const rows: ModelMappingRow[] = [];
    const seen = new Set<string>();
    for (const [requestName, upstreamName] of Object.entries(channel.modelMap || {})) {
        const request = requestName.trim();
        if (!request || seen.has(request)) continue;
        seen.add(request);
        rows.push(emptyModelMappingRow(rows, request, String(upstreamName || "").trim()));
    }
    for (const requestName of channel.models || []) {
        const request = requestName.trim();
        if (!request || seen.has(request)) continue;
        seen.add(request);
        rows.push(emptyModelMappingRow(rows, request, ""));
    }
    const visible = new Set(rows.flatMap((item) => [item.requestName, item.upstreamName]).filter(Boolean));
    for (const upstreamName of upstreamModels) {
        const upstream = upstreamName.trim();
        if (upstream && !visible.has(upstream)) {
            visible.add(upstream);
            rows.push(emptyModelMappingRow(rows, "", upstream));
        }
    }
    return rows;
}

export function appendUpstreamModelRows(rows: ModelMappingRow[], upstreamModels: string[]) {
    const next = rows.map((item) => ({ ...item }));
    const visible = new Set(next.flatMap((item) => [item.requestName.trim(), item.upstreamName.trim()]).filter(Boolean));
    for (const upstreamName of upstreamModels) {
        const upstream = upstreamName.trim();
        if (upstream && !visible.has(upstream)) {
            visible.add(upstream);
            next.push(emptyModelMappingRow(next, "", upstream));
        }
    }
    return next;
}

export function deriveModelMapping(rows: ModelMappingRow[]) {
    const models: string[] = [];
    const modelMap: Record<string, string> = {};
    const seen = new Set<string>();
    for (const item of rows) {
        const request = item.requestName.trim();
        const upstream = item.upstreamName.trim();
        const resolvedRequest = request || upstream;
        const resolvedUpstream = upstream || request;
        if (!resolvedRequest || seen.has(resolvedRequest)) continue;
        seen.add(resolvedRequest);
        models.push(resolvedRequest);
        if (resolvedRequest !== resolvedUpstream) modelMap[resolvedRequest] = resolvedUpstream;
    }
    return { models, modelMap: Object.keys(modelMap).length ? modelMap : undefined };
}

type Props = {
    rows: ModelMappingRow[];
    requestModels?: string[];
    upstreamModels?: string[];
    onChange: (rows: ModelMappingRow[]) => void;
    onCommit?: () => void;
    onRemove: (row: ModelMappingRow) => void;
    onAdd: () => void;
};

export function ModelMappingEditor({ rows, requestModels = [], upstreamModels = [], onChange, onCommit, onRemove, onAdd }: Props) {
    return (
        <div data-testid="model-mapping-editor">
            <Typography.Text type="secondary" style={{ display: "block", marginBottom: 10 }}>画板/客户端调用左侧的名字；平台把请求转发给右侧的上游模型。只填一侧 = 不改名（该名字同时是请求名和上游名）。</Typography.Text>
            <Table<ModelMappingRow>
                size="small"
                pagination={false}
                rowKey="id"
                dataSource={rows}
                columns={[
                    {
                        title: "请求模型名称（画板里显示/选择）",
                        render: (_, item) => (
                            <AutoComplete
                                value={item.requestName}
                                options={requestModels.map((value) => ({ label: value, value }))}
                                onChange={(value) => onChange(rows.map((row) => row.id === item.id ? { ...row, requestName: value } : row))}
                                onBlur={onCommit}
                                aria-label="请求模型名称"
                                className="!w-full"
                            />
                        ),
                    },
                    {
                        title: "上游模型名称（实际发给上游）",
                        render: (_, item) => (
                            <AutoComplete
                                value={item.upstreamName}
                                allowClear
                                options={upstreamModels.map((value) => ({ label: value, value }))}
                                onChange={(value) => onChange(rows.map((row) => row.id === item.id ? { ...row, upstreamName: value } : row))}
                                onBlur={onCommit}
                                placeholder="上游模型名称"
                                aria-label="上游模型名称"
                                className="!w-full"
                            />
                        ),
                    },
                    {
                        title: "操作",
                        width: 70,
                        render: (_, item) => <Button type="text" danger icon={<DeleteOutlined />} aria-label="删除映射行" onClick={() => onRemove(item)} />,
                    },
                ]}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <Button type="dashed" icon={<PlusOutlined />} onClick={onAdd}>+ 添加映射</Button>
            </div>
        </div>
    );
}
