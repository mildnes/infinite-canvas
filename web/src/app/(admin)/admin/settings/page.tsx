"use client";

import { CheckCircleOutlined, DeleteOutlined, FormatPainterOutlined, LoadingOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { json } from "@codemirror/lang-json";
import { App, Button, Card, Checkbox, Col, Collapse, Drawer, Flex, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space, Switch, Table, Tabs, Tag, Typography } from "antd";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@uiw/react-codemirror";

import { ChannelModelSelectorModal } from "@/components/channel-model-selector-modal";
import type { WorkflowChannelSettings } from "@/components/workflow/workflow-channel-pane";
import { IMAGE_QUALITY_OPTIONS, type ImageQualityCapability } from "@/lib/image-quality";
import { imageOutputFormatOptions, type ImageOutputCapability } from "@/lib/image-output-format";
import { isWorkflowProtocol, modelChannelApiKeyUrls, modelChannelDefaultBaseUrls, modelChannelProtocolOptions } from "@/lib/model-channel";
import type { ModelCapability } from "@/lib/model-capability";
import { fetchAdminSettings, fetchChannelModels, fetchMCPServerTools, measureAdminStorageProvider, saveAdminSettings, testChannelModel, type AdminMCPServer, type AdminMCPTool, type AdminModelChannel, type AdminModelCost, type AdminSettings, type AdminStorageProvider } from "@/services/api/admin";
import { clearStorageConfigCache as clearMediaStorageConfigCache } from "@/services/file-storage";
import { clearStorageConfigCache as clearImageStorageConfigCache } from "@/services/image-storage";
import { modelMatchesCapability, notifyPublicSettingsUpdated } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { normalizeImageQualityCapabilities } from "./image-quality-capabilities";
import { normalizeImageOutputCapabilities } from "./image-output-capabilities";
import { availableUserGroupModels, normalizeUserGroups } from "@/lib/user-groups";
import { UserGroupEditor } from "./user-group-editor";
import { appendUpstreamModelRows, buildModelMappingRows, deriveModelMapping, emptyModelMappingRow, ModelMappingEditor, type ModelMappingRow } from "./model-mapping-editor";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });
const WorkflowChannelPane = dynamic(() => import("@/components/workflow/workflow-channel-pane").then((module) => module.WorkflowChannelPane), { ssr: false });
const jsonEditorTheme = EditorView.theme({
    "&": { backgroundColor: "var(--ant-color-bg-container)", color: "var(--ant-color-text)" },
    ".cm-content": { caretColor: "var(--ant-color-text)", padding: "12px 0" },
    ".cm-line": { padding: "0 18px" },
    ".cm-gutters": { backgroundColor: "var(--ant-color-fill-quaternary)", borderRight: "1px solid var(--ant-color-border)", color: "var(--ant-color-text-tertiary)" },
    ".cm-activeLine": { backgroundColor: "var(--ant-color-fill-quaternary)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--ant-color-fill-quaternary)", color: "var(--ant-color-text)" },
    ".cm-cursor": { borderLeftColor: "var(--ant-color-text)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--ant-control-item-bg-active)" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--ant-color-fill-quaternary)", border: "1px solid var(--ant-color-border)", color: "var(--ant-color-text-tertiary)" },
    "&.cm-focused": { outline: "none" },
});

const emptySettings: AdminSettings = {
    public: {
        modelChannel: {
            availableModels: [],
            availableWorkflows: [],
            modelCosts: [],
            channels: [],
            defaultModel: "",
            defaultImageModel: "",
            defaultVideoModel: "",
            defaultTextModel: "",
            systemPrompt: "",
            systemPrompts: { image: "", video: "", text: "", workflow: "", workflowAgent: "" },
            allowCustomChannel: true,
            allowUserRemoteChannel: false,
        },
        auth: { allowRegister: true, linuxDo: { enabled: false } },
        storage: { mode: "local_indexeddb", allowUserProvider: false },
    },
    private: { channels: [], agent: { mcpServers: [] }, promptSync: { enabled: true, cron: "0 0 * * *" }, aiLog: { localDirectReportEnabled: false, cleanup: { enabled: false, retentionDays: 14, cron: "0 3 * * *" } }, auth: { linuxDo: { clientId: "", clientSecret: "" } }, storage: { mode: "local_indexeddb", allowUserProvider: false, allowUserGlobalProvider: true, autoSyncAllAssets: false, providers: [], roundRobinCursor: 0, capacityCheck: { enabled: false, cron: "0 */6 * * *" }, capacityLimitBytes: 9 * 1024 * 1024 * 1024 } },
};
const emptyChannel: AdminModelChannel = { id: "", protocol: "openai", name: "", baseUrl: modelChannelDefaultBaseUrls.openai, apiKey: "", models: [], weight: 1, timeout: 600, enabled: true, remark: "" };
const modelCapabilityOptions: { label: string; value: ModelCapability }[] = [
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "文本", value: "text" },
    { label: "音频", value: "audio" },
];
const emptyS3StorageProvider: AdminStorageProvider = { id: "", name: "", type: "s3", endpoint: "", region: "auto", bucket: "", accessKeyId: "", secretAccessKey: "", publicBaseUrl: "", pathPrefix: "canvas", username: "", password: "", weight: 1, enabled: true, ownerUserId: "", capacityBytes: 0, capacityCheckedAt: "", capacityExceeded: false };
const emptyWebDAVStorageProvider: AdminStorageProvider = { ...emptyS3StorageProvider, name: "", type: "webdav", region: "" };
const emptyMCPServer: AdminMCPServer = { id: "", name: "", endpoint: "", apiKey: "", transport: "streamable_http", command: "", args: [], env: {}, workingDirectory: "", description: "", tools: [], enabled: true, allowUsers: true };

type SettingsTabKey = "public" | "private";
type EditorMode = "visual" | "json";

export default function AdminSettingsPage() {
    const token = useUserStore((state) => state.token);
    const { message } = App.useApp();
    const [form] = Form.useForm<AdminSettings>();
    const [activeTab, setActiveTab] = useState<SettingsTabKey | "groups">("public");
    const [editorMode, setEditorMode] = useState<Record<SettingsTabKey, EditorMode>>({ public: "visual", private: "visual" });
    const [jsonText, setJsonText] = useState<Record<SettingsTabKey, string>>({ public: "", private: "" });
    const [channels, setChannels] = useState<AdminModelChannel[]>([]);
    const [channelForm] = Form.useForm<AdminModelChannel>();
    const [bulkTargetModels, setBulkTargetModels] = useState<string[]>([]);
    const [bulkModelCapabilities, setBulkModelCapabilities] = useState<ModelCapability[]>([]);
    const [editingChannelIndex, setEditingChannelIndex] = useState<number | null>(null);
    const [isChannelDrawerOpen, setIsChannelDrawerOpen] = useState(false);
    const [workflowChannelDraft, setWorkflowChannelDraft] = useState<AdminModelChannel>(emptyChannel);
    const [testChannelIndex, setTestChannelIndex] = useState<number | null>(null);
    const [testKeyword, setTestKeyword] = useState("");
    const [selectedTestModels, setSelectedTestModels] = useState<string[]>([]);
    const [testingModels, setTestingModels] = useState<string[]>([]);
    const [testResults, setTestResults] = useState<Record<string, { status: "success" | "error"; duration?: string; message: string }>>({});
    const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [measuringProviderIndex, setMeasuringProviderIndex] = useState<number | null>(null);
    const [fetchingMCPToolsIndex, setFetchingMCPToolsIndex] = useState<number | null>(null);
    const [modelCosts, setModelCosts] = useState<AdminModelCost[]>([]);
    const [knownModels, setKnownModels] = useState<string[]>([]);
    // Snapshot all saved request names, including same-name passthrough rows.
    const savedRequestModelNamesRef = useRef<string[]>([]);
    const savedUserGroupsRef = useRef<NonNullable<AdminSettings["public"]["modelChannel"]["userGroups"]>>([]);
    const [modelMappingRows, setModelMappingRows] = useState<ModelMappingRow[]>([]);
    const [channelUpstreamModels, setChannelUpstreamModels] = useState<string[]>([]);
    const committedModelRowsRef = useRef<ModelMappingRow[]>([]);
    const publicModels = Form.useWatch(["public", "modelChannel", "availableModels"], { form, preserve: true }) || [];
    const userGroups = Form.useWatch(["public", "modelChannel", "userGroups"], { form, preserve: true }) || [];
    const publicWorkflows = Form.useWatch(["public", "modelChannel", "availableWorkflows"], form) || [];
    const storageProviders = Form.useWatch(["private", "storage", "providers"], form) || [];
    const agentMCPServers = Form.useWatch(["private", "agent", "mcpServers"], form) || [];
    const channelProtocol = Form.useWatch("protocol", channelForm);
    const rawSelectedChannelModels = Form.useWatch("models", { form: channelForm, preserve: true }) || [];
    const channelModelMap = Form.useWatch("modelMap", { form: channelForm, preserve: true }) || {};
    const selectedChannelModels = useMemo(() => deriveModelMapping(modelMappingRows).models, [modelMappingRows]);
    const channelModelCapabilities = Form.useWatch("modelCapabilities", { form: channelForm, preserve: true }) || {};
    const channelImageQualityCapabilities = Form.useWatch("imageQualityCapabilities", { form: channelForm, preserve: true }) || {};
    const channelImageOutputCapabilities = Form.useWatch("imageOutputCapabilities", { form: channelForm, preserve: true }) || {};
    const defaultImageModel = Form.useWatch(["public", "modelChannel", "defaultImageModel"], form) || "";
    const channelApiKeyUrl = channelProtocol ? modelChannelApiKeyUrls[channelProtocol] : undefined;
    const modelLabel = (model: string, _channel?: unknown) => model;
    const publicModelLabel = (model: string) => model;
    const channelModels = useMemo(() => collectChannelModels(channels), [channels]);
    const channelWorkflows = useMemo(() => collectChannelWorkflows(channels), [channels]);
    const channelTableData = useMemo(() => channels.map((channel, index) => ({ ...channel, _index: index, _rowKey: `${index}-${channel.name}-${channel.baseUrl}` })), [channels]);
    const defaultImageModelExcluded = useMemo(() => {
        if (!defaultImageModel) return false;
        const candidates = channels.filter((channel) => channel.enabled && !isWorkflowProtocol(channel.protocol) && channel.models.includes(defaultImageModel));
        return candidates.length > 0 && candidates.every((channel) => {
            const capabilities = channel.modelCapabilities?.[defaultImageModel];
            return Array.isArray(capabilities) && !capabilities.includes("image");
        });
    }, [channels, defaultImageModel]);
    const settingsTab = activeTab === "groups" ? "public" : activeTab;
    const activeMode = editorMode[settingsTab];
    const activeJsonText = jsonText[settingsTab];
    const jsonError = activeMode === "json" ? getJsonError(activeJsonText) : "";

    const loadSettings = async () => {
        if (!token) return;
        setIsLoading(true);
        try {
            const data = normalizeSettings(await fetchAdminSettings(token));
            data.public.modelChannel.userGroups = normalizeUserGroups(data.public.modelChannel.userGroups, availableUserGroupModels(data), undefined, data.private.channels);
            savedUserGroupsRef.current = data.public.modelChannel.userGroups;
            form.setFieldsValue(data);
            setChannels(data.private.channels);
            savedRequestModelNamesRef.current = collectChannelModels(data.private.channels);
            setModelCosts(data.public.modelChannel.modelCosts);
            setKnownModels(collectKnownModels(data));
            setJsonText({
                public: JSON.stringify(data.public, null, 2),
                private: JSON.stringify(data.private, null, 2),
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取设置失败");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        void loadSettings();
    }, [token]);

    const changeTab = (nextTab: SettingsTabKey | "groups") => {
        if (nextTab === "groups" && editorMode.public === "json") {
            const parsed = parseTabJson("public", jsonText.public);
            if (!parsed) { message.error("请先修正公开配置 JSON"); return; }
            form.setFieldsValue({ public: parsed });
        }
        setActiveTab(nextTab);
    };

    const saveSettings = async () => {
        if (!token) return;
        const values = await collectSettings(form, editorMode, jsonText, message, savedRequestModelNamesRef.current, savedUserGroupsRef.current);
        if (!values) {
            return;
        }
        setIsSaving(true);
        try {
            const saved = normalizeSettings(await saveAdminSettings(token, values));
            clearImageStorageConfigCache();
            clearMediaStorageConfigCache();
            const merged = mergeChannelApiKeys(values.private.channels, saved);
            savedUserGroupsRef.current = merged.public.modelChannel.userGroups || [];
            form.setFieldsValue(merged);
            setChannels(merged.private.channels);
            savedRequestModelNamesRef.current = collectChannelModels(merged.private.channels);
            setModelCosts(merged.public.modelChannel.modelCosts);
            rememberKnownModels(merged);
            setJsonText({
                public: JSON.stringify(merged.public, null, 2),
                private: JSON.stringify(merged.private, null, 2),
            });
            notifyPublicSettingsUpdated();
            message.success("已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setIsSaving(false);
        }
    };

    const toggleMode = (tab: SettingsTabKey, nextMode: EditorMode) => {
        if (nextMode === "json") {
            setJsonText((current) => ({
                ...current,
                [tab]: JSON.stringify(tab === "public" ? normalizePublicSetting(form.getFieldValue(["public"]) as Partial<AdminSettings["public"]>) : normalizePrivateSetting(form.getFieldValue(["private"]) as Partial<AdminSettings["private"]>), null, 2),
            }));
            setEditorMode((current) => ({ ...current, [tab]: nextMode }));
            return;
        }
        const parsed = parseTabJson(tab, jsonText[tab]);
        if (!parsed) {
            message.error("JSON 格式不正确");
            return;
        }
        form.setFieldsValue({ [tab]: parsed } as Partial<AdminSettings>);
        if (tab === "private") setChannels((parsed as AdminSettings["private"]).channels);
        if (tab === "public") setModelCosts((parsed as AdminSettings["public"]).modelChannel.modelCosts);
        rememberKnownModels({ ...normalizeSettings(form.getFieldsValue(true) as AdminSettings), [tab]: parsed });
        setEditorMode((current) => ({ ...current, [tab]: nextMode }));
    };

    const formatJson = (tab: SettingsTabKey) => {
        const parsed = parseTabJson(tab, jsonText[tab]);
        if (!parsed) {
            message.error("JSON 格式不正确");
            return;
        }
        if (tab === "public") setModelCosts((parsed as AdminSettings["public"]).modelChannel.modelCosts);
        setJsonText((current) => ({
            ...current,
            [tab]: JSON.stringify(parsed, null, 2),
        }));
    };

    const openChannelDrawer = (index: number | null) => {
        setEditingChannelIndex(index);
        setIsChannelDrawerOpen(true);
        const channel = index === null ? emptyChannel : normalizeChannel(channels[index]);
        channelForm.setFieldsValue(channel);
        const existingUpstreamModels = Object.values(channel.modelMap || {});
        const rows = buildModelMappingRows(channel, existingUpstreamModels);
        setModelMappingRows(rows);
        committedModelRowsRef.current = rows;
        setChannelUpstreamModels(uniqueModels(existingUpstreamModels));
        setBulkTargetModels([]);
        setBulkModelCapabilities([]);
        setWorkflowChannelDraft(channel);
        rememberModels(channel.models);
    };

    const closeChannelDrawer = () => {
        setIsChannelDrawerOpen(false);
        setEditingChannelIndex(null);
        channelForm.resetFields();
        setModelMappingRows([]);
        setChannelUpstreamModels([]);
    };

    const saveChannel = async () => {
        commitModelMappingRows(modelMappingRows);
        const values = await channelForm.validateFields();
        const derived = deriveModelMapping(modelMappingRows);
        const channel = normalizeChannel({ ...(isWorkflowProtocol(values.protocol) ? workflowChannelDraft : {}), ...channelForm.getFieldsValue(true), ...values, ...(!isWorkflowProtocol(values.protocol) ? derived : {}) });
        if (channel.protocol === "runninghub" && (!channel.baseUrl.trim() || (!channel.apiKey.trim() && editingChannelIndex === null))) {
            message.error("请填写 RunningHub Base URL 和积分 API Key");
            return;
        }
        rememberModels(channel.models);
        const nextChannels = [...channels];
        if (editingChannelIndex === null) nextChannels.push(channel);
        else nextChannels[editingChannelIndex] = channel;
        await persistChannels(nextChannels);
        closeChannelDrawer();
    };

    const fetchChannelModelList = async () => {
        if (!token) return;
        const channel = channelForm.getFieldsValue();
        if (!channel?.baseUrl) {
            message.warning("请先填写接口地址");
            return;
        }
        if (editingChannelIndex === null && !channel?.apiKey) {
            message.warning("请先填写 API Key");
            return;
        }
        return fetchChannelModels(token, { index: editingChannelIndex ?? undefined, channel: normalizeChannel(channel) });
    };

    const openChannelModelSelector = () => setIsModelSelectorOpen(true);

    const closeChannelModelSelector = () => setIsModelSelectorOpen(false);

    const confirmChannelModelSelector = (models: string[]) => {
        const nextRows = appendUpstreamModelRows(modelMappingRows, models);
        setModelMappingRows(nextRows);
        setChannelUpstreamModels((current) => uniqueModels([...current, ...models]));
        rememberModels(models);
        closeChannelModelSelector();
    };

    const addModelMapping = () => {
        setModelMappingRows((current) => [...current, emptyModelMappingRow(current)]);
    };

    const removeModelMapping = (item: ModelMappingRow) => {
        const next = modelMappingRows.filter((row) => row.id !== item.id);
        setModelMappingRows(next);
        commitModelMappingRows(next);
    };

    const updateModelMappingRows = (rows: ModelMappingRow[]) => {
        setModelMappingRows(rows);
    };

    function commitModelMappingRows(rows: ModelMappingRow[]) {
        if (isWorkflowProtocol(channelForm.getFieldValue("protocol"))) return;
        const next = applyModelMappingRows(channelForm.getFieldsValue(true), rows, committedModelRowsRef.current);
        // setFieldsValue merges nested maps; exact field replacement removes renamed/deleted keys.
        for (const key of ["models", "modelMap", "modelCapabilities", "imageQualityCapabilities", "imageOutputCapabilities"] as const) {
            channelForm.setFieldValue(key, next[key]);
        }
        committedModelRowsRef.current = rows;
    }

    const updateChannelModelCapabilities = (model: string, values?: ModelCapability[]) => {
        const next: NonNullable<AdminModelChannel["modelCapabilities"]> = { ...(channelForm.getFieldValue("modelCapabilities") || {}) };
        if (values === undefined) delete next[model];
        else next[model] = uniqueCapabilities(values);
        channelForm.setFieldValue("modelCapabilities", Object.keys(next).length ? next : undefined);
    };

    const applyBulkModelCapabilities = () => {
        const next: NonNullable<AdminModelChannel["modelCapabilities"]> = { ...(channelForm.getFieldValue("modelCapabilities") || {}) };
        for (const model of bulkTargetModels.filter((item) => selectedChannelModels.includes(item))) {
            if (bulkModelCapabilities.length) next[model] = bulkModelCapabilities;
            else delete next[model];
        }
        channelForm.setFieldValue("modelCapabilities", Object.keys(next).length ? next : undefined);
    };

    const updateChannelImageQualityCapability = (model: string, capability?: ImageQualityCapability) => {
        const next = { ...(channelForm.getFieldValue("imageQualityCapabilities") || {}) };
        if (capability === undefined) delete next[model];
        else next[model] = capability;
        channelForm.setFieldValue("imageQualityCapabilities", normalizeImageQualityCapabilities(next, selectedChannelModels));
    };

    const updateChannelImageOutputCapability = (model: string, capability?: ImageOutputCapability) => {
        const next = { ...(channelForm.getFieldValue("imageOutputCapabilities") || {}) };
        if (capability === undefined) delete next[model];
        else next[model] = capability;
        channelForm.setFieldValue("imageOutputCapabilities", normalizeImageOutputCapabilities(next, selectedChannelModels));
    };

    function rememberModels(models: string[]) {
        setKnownModels((current) => uniqueModels([...current, ...models]));
    }

    function rememberKnownModels(settings: AdminSettings) {
        rememberModels(collectKnownModels(settings));
    }

    const openTestDialog = (index: number) => {
        const channel = normalizeChannel(channels[index]);
        if (!channel.baseUrl || channel.models.length === 0) {
            message.warning("请先填写接口地址和至少一个模型");
            return;
        }
        setTestChannelIndex(index);
        setTestKeyword("");
        setSelectedTestModels([]);
        setTestingModels([]);
        setTestResults({});
    };

    const closeTestDialog = () => {
        setTestChannelIndex(null);
        setTestKeyword("");
        setSelectedTestModels([]);
        setTestingModels([]);
        setTestResults({});
    };

    const testModelOnline = async (model: string) => {
        if (testChannelIndex === null) return;
        if (!token) return;
        const channel = normalizeChannel(channels[testChannelIndex]);
        setTestingModels((current) => [...current, model]);
        try {
            const startedAt = performance.now();
            const result = await testChannelModel(token, { index: testChannelIndex, channel, model });
            setTestResults((current) => ({ ...current, [model]: { status: "success", duration: `${((performance.now() - startedAt) / 1000).toFixed(2)}s`, message: result } }));
        } catch (error) {
            setTestResults((current) => ({ ...current, [model]: { status: "error", message: error instanceof Error ? error.message : "测试失败" } }));
        } finally {
            setTestingModels((current) => current.filter((item) => item !== model));
        }
    };

    const batchTestModels = async () => {
        for (const model of selectedTestModels) {
            await testModelOnline(model);
        }
    };

    const testChannel = testChannelIndex === null ? null : normalizeChannel(channels[testChannelIndex]);
    const testModels = (testChannel?.models || []).filter((model) => `${model} ${modelLabel(model, testChannel)}`.toLowerCase().includes(testKeyword.trim().toLowerCase()));

    async function persistChannels(nextChannels: AdminModelChannel[]) {
        if (!token) throw new Error("请先登录");
        const values = normalizeSettings(form.getFieldsValue(true) as AdminSettings);
        const nextChannelWorkflows = collectChannelWorkflows(nextChannels);
        const newlyAddedRequestNames = collectChannelModels(nextChannels).filter((name) => !savedRequestModelNamesRef.current.includes(name));
        const nextSettings = normalizeSettings({
            ...values,
            public: { ...values.public, modelChannel: { ...values.public.modelChannel, availableModels: resolveAvailableModels(values.public.modelChannel.availableModels, nextChannels, newlyAddedRequestNames), availableWorkflows: filterModels(values.public.modelChannel.availableWorkflows, nextChannelWorkflows.map((item) => item.value)) } },
            private: { ...values.private, channels: nextChannels },
        });
        nextSettings.public.modelChannel.userGroups = normalizeUserGroups(nextSettings.public.modelChannel.userGroups, availableUserGroupModels(nextSettings), savedUserGroupsRef.current, nextSettings.private.channels);
        const saved = normalizeSettings(await saveAdminSettings(token, nextSettings));
        clearImageStorageConfigCache();
        clearMediaStorageConfigCache();
        const merged = mergeChannelApiKeys(nextChannels, saved);
        savedUserGroupsRef.current = merged.public.modelChannel.userGroups || [];
        setChannels(merged.private.channels);
        savedRequestModelNamesRef.current = collectChannelModels(merged.private.channels);
        setModelCosts(merged.public.modelChannel.modelCosts);
        rememberKnownModels(merged);
        form.setFieldsValue(merged);
        setJsonText({
            public: JSON.stringify(merged.public, null, 2),
            private: JSON.stringify(merged.private, null, 2),
        });
        notifyPublicSettingsUpdated();
        message.success("已保存");
    }

    async function loadMCPToolsAt(index: number) {
        if (!token) return;
        const server = form.getFieldValue(["private", "agent", "mcpServers", index]) as AdminMCPServer | undefined;
        const transport = server?.transport === "stdio" ? "stdio" : "streamable_http";
        if (transport === "stdio" ? !server?.command?.trim() : !server?.endpoint?.trim()) {
            message.warning(transport === "stdio" ? "请先填写 MCP Command" : "请先填写 MCP 服务地址");
            return;
        }
        setFetchingMCPToolsIndex(index);
        try {
            const tools = await fetchMCPServerTools(token, { server: normalizeMCPServer(server) });
            form.setFieldValue(["private", "agent", "mcpServers", index, "tools"], tools);
            form.setFieldValue(["private", "agent", "mcpServers", index, "toolsJson"], JSON.stringify(tools, null, 2));
            message.success(`已读取 ${tools.length} 个 MCP 工具`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取 MCP 工具失败");
        } finally {
            setFetchingMCPToolsIndex(null);
        }
    }

    async function measureStorageProviderAt(index: number) {
        if (!token) return;
        const provider = normalizeStorageProvider(form.getFieldValue(["private", "storage", "providers", index]));
        setMeasuringProviderIndex(index);
        try {
            const result = await measureAdminStorageProvider(token, { index, provider });
            const next = normalizeSettings(await fetchAdminSettings(token));
            form.setFieldsValue(next);
            setJsonText({ public: JSON.stringify(next.public, null, 2), private: JSON.stringify(next.private, null, 2) });
            message.success(`容量统计完成：${formatStorageBytes(result.bytes)}${result.overLimit ? "，已达到上限并禁用" : ""}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "容量统计失败");
        } finally {
            setMeasuringProviderIndex(null);
        }
    }

    return (
        <main className="p-3 md:p-6">
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <Flex justify="space-between" align="center" gap={16} wrap>
                        <Tabs
                            activeKey={activeTab}
                            onChange={(key) => changeTab(key as SettingsTabKey | "groups")}
                            items={[
                                { key: "public", label: "公开配置（对外暴露）" },
                                { key: "private", label: "私有配置（不会对外暴露）" },
                                { key: "groups", label: "用户分组" },
                            ]}
                        />
                        <Space>
                            <Button icon={<ReloadOutlined />} loading={isLoading} onClick={() => void loadSettings()}>
                                刷新
                            </Button>
                            <Button type="primary" icon={<SaveOutlined />} loading={isSaving} onClick={() => void saveSettings()}>
                                保存设置
                            </Button>
                        </Space>
                    </Flex>
                </Card>

                <Card variant="borderless">
                    {activeTab !== "groups" ? <Flex justify="space-between" align="center" gap={16} wrap style={{ marginBottom: 16 }}>
                        <Segmented
                            value={activeMode}
                            onChange={(value) => toggleMode(settingsTab, value as EditorMode)}
                            options={[
                                { label: "可视化编辑", value: "visual" },
                                { label: "手动编辑 JSON", value: "json" },
                            ]}
                        />
                        {activeMode === "json" ? (
                            <Space>
                                {jsonError ? (
                                    <Tag color="error">{jsonError}</Tag>
                                ) : (
                                    <Tag color="success" icon={<CheckCircleOutlined />}>
                                        JSON 格式正确
                                    </Tag>
                                )}
                                <Button icon={<FormatPainterOutlined />} onClick={() => formatJson(settingsTab)}>
                                    格式化
                                </Button>
                            </Space>
                        ) : (
                            <Typography.Text type="secondary">{activeTab === "public" ? "这些配置会暴露给前端读取" : "这些配置只会在后台保存"}</Typography.Text>
                        )}
                    </Flex> : null}

                    {activeTab === "groups" ? <UserGroupEditor groups={userGroups} models={publicModels.length ? publicModels : channelModels} channels={channels} onChange={(groups) => {
                        form.setFieldValue(["public", "modelChannel", "userGroups"], groups);
                        if (editorMode.public === "json") {
                            const parsed = parseTabJson("public", jsonText.public);
                            if (parsed) setJsonText((current) => ({ ...current, public: JSON.stringify({ ...parsed, modelChannel: { ...parsed.modelChannel, userGroups: groups } }, null, 2) }));
                        }
                    }} /> : activeTab === "public" ? (
                        activeMode === "visual" ? (
                            <Form form={form} layout="vertical" initialValues={emptySettings} requiredMark={false}>
                                <Row gutter={16}>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "availableModels"]} label="系统可用模型(请先在私有配置里配置渠道)" extra="可选项来自已启用渠道中选择的模型，最终开放哪些模型由这里勾选决定">
                                            <Select mode="multiple" showSearch={{ optionFilterProp: ["label", "value"] }} placeholder="请选择系统可用模型" options={channelModels.map((item) => ({ label: publicModelLabel(item), value: item }))} />
                                        </Form.Item>
                                        <Form.Item name={["public", "modelChannel", "availableWorkflows"]} label="系统可用工作流" extra="先在私有渠道启用工作流，再在这里勾选对用户开放的工作流">
                                            <Select mode="multiple" showSearch={{ optionFilterProp: ["label", "value"] }} placeholder="请选择系统可用工作流" options={channelWorkflows} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultModel"]} label="默认模型">
                                            <Select showSearch={{ optionFilterProp: ["label", "value"] }} allowClear options={publicModels.map((item) => ({ label: publicModelLabel(item), value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item
                                            name={["public", "modelChannel", "defaultImageModel"]}
                                            label="默认图片模型"
                                            extra={defaultImageModelExcluded ? <Typography.Text type="warning">当前默认模型在所有所属渠道都未声明图片能力，前端会过滤该模型。请编辑渠道能力或更换默认图片模型。</Typography.Text> : undefined}
                                        >
                                            <Select showSearch={{ optionFilterProp: ["label", "value"] }} allowClear options={publicModels.map((item) => ({ label: publicModelLabel(item), value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultVideoModel"]} label="默认视频模型">
                                            <Select showSearch={{ optionFilterProp: ["label", "value"] }} allowClear options={publicModels.map((item) => ({ label: publicModelLabel(item), value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultTextModel"]} label="默认文本模型">
                                            <Select showSearch={{ optionFilterProp: ["label", "value"] }} allowClear options={publicModels.map((item) => ({ label: publicModelLabel(item), value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Typography.Title level={5}>内置/系统提示词</Typography.Title>
                                        <Row gutter={16}>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["public", "modelChannel", "systemPrompts", "image"]} label="生图系统提示词">
                                                    <Input.TextArea rows={4} placeholder="会自动追加在生图提示词前，不在输入框中展示" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["public", "modelChannel", "systemPrompts", "video"]} label="视频系统提示词">
                                                    <Input.TextArea rows={4} placeholder="会自动追加在视频提示词前" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["public", "modelChannel", "systemPrompts", "text"]} label="文本/问答系统提示词">
                                                    <Input.TextArea rows={4} placeholder="用于画布问答、AI 文本等文本模型调用" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["public", "modelChannel", "systemPrompts", "workflow"]} label="工作流运行系统提示词">
                                                    <Input.TextArea rows={4} placeholder="用于工作流运行时补充统一创作要求" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24}>
                                                <Form.Item name={["public", "modelChannel", "systemPrompts", "workflowAgent"]} label="工作流创建 Agent 系统提示词">
                                                    <Input.TextArea rows={6} placeholder="控制 AI 创建工作流的输出规范和默认参数" />
                                                </Form.Item>
                                            </Col>
                                        </Row>
                                        <Form.Item name={["public", "modelChannel", "systemPrompt"]} hidden>
                                            <Input />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "allowCustomChannel"]} label="是否允许用户自定义渠道" extra="开启后，前端可提供用户自定义 baseUrl 直连模式" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "allowUserRemoteChannel"]} label="是否允许普通用户使用云端渠道" extra="关闭后，普通用户只能使用本地直连；管理员仍可使用云端渠道" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "auth", "allowRegister"]} label="是否允许用户注册" extra="关闭后隐藏注册入口，注册接口也会拒绝新用户创建" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Typography.Title level={5}>模型／工作流算力点</Typography.Title>
                                        <Table
                                            rowKey={(item) => `${item.channelId || "legacy"}:${item.model}`}
                                            pagination={false}
                                            size="small"
                                            dataSource={[
                                                ...channels.flatMap((channel) => (channel.models || []).map((model) => ({ channelId: channel.id, model, label: `${channel.name || channel.id} · ${publicModelLabel(model)}`, credits: modelCostCredits(modelCosts, channel.id, model) }))),
                                                ...publicModels.filter((model) => !channels.some((channel) => (channel.models || []).includes(model))).map((model) => ({ channelId: "", model, label: publicModelLabel(model), credits: modelCostCredits(modelCosts, "", model) })),
                                                ...channels.flatMap((channel) => isWorkflowProtocol(channel.protocol) ? (channel.workflows || []).filter((entry) => entry.enabled && publicWorkflows.includes(`workflow:system:${channel.id}:${entry.kind}:${entry.workflowId}`)).map((entry) => {
                                                    const model = `workflow:system:${channel.id}:${entry.kind}:${entry.workflowId}`;
                                                    return { channelId: channel.id, model, label: `${channel.name} · ${entry.title || entry.workflowId}（工作流）`, credits: modelCostCredits(modelCosts, channel.id, model) };
                                                }) : []),
                                            ]}
                                            columns={[
                                                { title: "模型 / 工作流", dataIndex: "model", render: (_, item) => <span title={item.label}>{item.label}</span> },
                                                {
                                                    title: (
                                                        <span className="grid leading-tight">
                                                            <span>计费单价</span>
                                                            <span className="text-xs font-normal text-[var(--ant-color-text-secondary)]">视频模型按秒，工作流按次</span>
                                                        </span>
                                                    ),
                                                    dataIndex: "credits",
                                                    width: 220,
                                                    render: (_, item) => (
                                                        <Space.Compact className="!w-full">
                                                            <InputNumber min={0} step={0.01} precision={2} className="!w-full" value={item.credits} onChange={(value) => setModelCost(form, setModelCosts, item.channelId, item.model, Number(value) || 0)} />
                                                            <span className="flex h-8 items-center rounded-r-md border border-l-0 border-stone-200 bg-stone-50 px-3 text-sm text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
                                                                点
                                                            </span>
                                                        </Space.Compact>
                                                    ),
                                                },
                                            ]}
                                        />
                                    </Col>
                                </Row>
                            </Form>
                        ) : (
                            <div style={{ overflow: "hidden", border: "1px solid var(--ant-color-border)", borderRadius: 6 }}>
                                <CodeMirror
                                    value={activeJsonText}
                                    height="520px"
                                    extensions={[json(), jsonEditorTheme]}
                                    basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true, highlightActiveLineGutter: true }}
                                    theme="none"
                                    onChange={(value) => setJsonText((current) => ({ ...current, public: value }))}
                                    style={{ fontSize: 13 }}
                                />
                            </div>
                        )
                    ) : activeMode === "visual" ? (
                        <Form form={form} layout="vertical" initialValues={emptySettings} requiredMark={false}>
                            <Flex vertical gap={12}>
                                <Card
                                    size="small"
                                    title={
                                        <Space>
                                            <img src="/icons/linuxdo.svg" alt="" width={18} height={18} />
                                            Linux.do 登录
                                        </Space>
                                    }
                                >
                                    <Flex vertical gap={14}>
                                        <Typography.Text type="secondary">
                                            本项目接口回调地址是 /api/auth/linux-do/callback，请在 Linux.do 应用后台自行拼接站点前缀。
                                            <Typography.Link href="https://connect.linux.do" target="_blank" rel="noreferrer">
                                                点击此处管理你的 LinuxDO OAuth App
                                            </Typography.Link>
                                        </Typography.Text>
                                        <Row gutter={16}>
                                            <Col xs={24} md={6}>
                                                <Form.Item name={["public", "auth", "linuxDo", "enabled"]} label="开启 Linux.do 登录" valuePropName="checked">
                                                    <Switch />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={9}>
                                                <Form.Item name={["private", "auth", "linuxDo", "clientId"]} label="Linux.do Client ID">
                                                    <Input placeholder="输入 Linux.do OAuth App 的 ID" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={9}>
                                                <Form.Item name={["private", "auth", "linuxDo", "clientSecret"]} label="Linux.do Client Secret">
                                                    <Input.Password placeholder="留空则沿用已保存的密钥" />
                                                </Form.Item>
                                            </Col>
                                        </Row>
                                    </Flex>
                                </Card>
                                <Card size="small" title="提示词定时同步">
                                    <Row gutter={16} align="middle">
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "promptSync", "enabled"]} label="开启定时同步" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={16}>
                                            <Form.Item name={["private", "promptSync", "cron"]} label="Cron 表达式" extra="默认每天 0 点同步内置 GitHub 远程提示词源">
                                                <Input placeholder="0 0 * * *" />
                                            </Form.Item>
                                        </Col>
                                    </Row>
                                </Card>
                                <Card size="small" title="AI 调用日志">
                                    <Row gutter={16}>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "aiLog", "localDirectReportEnabled"]} label="本地直连日志上报" valuePropName="checked" extra="关闭后本地直连不上报；云端渠道仍默认记录。">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "aiLog", "cleanup", "enabled"]} label="开启自动清理" valuePropName="checked" extra="日志按天写入本地文件，不保存到 SQLite。">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "aiLog", "cleanup", "retentionDays"]} label="保留天数" extra="默认保留 14 天，超过后定时删除对应日期日志文件。">
                                                <InputNumber min={1} precision={0} className="!w-full" />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "aiLog", "cleanup", "cron"]} label="清理 Cron">
                                                <Input placeholder="0 3 * * *" />
                                            </Form.Item>
                                        </Col>
                                    </Row>
                                </Card>
                                <Card size="small" title="画布 Agent MCP">
                                    <Flex vertical gap={12}>
                                        <Typography.Text type="secondary">MCP 工具由后端代理调用，API Key、stdio 命令和环境变量不会下发给普通用户。</Typography.Text>
                                        <Form.List name={["private", "agent", "mcpServers"]}>
                                            {(fields, { add, remove }) => (
                                                <Flex vertical gap={10}>
                                                    <Button icon={<PlusOutlined />} onClick={() => add({ ...emptyMCPServer })}>
                                                        新增 MCP 服务
                                                    </Button>
                                                    {fields.map((field) => {
                                                        const server = agentMCPServers[field.name] || emptyMCPServer;
                                                        const isStdio = server.transport === "stdio";
                                                        return (
                                                            <Card key={field.key} size="small" title={server.name || `MCP ${field.name + 1}`} extra={<Button danger size="small" icon={<DeleteOutlined />} onClick={() => remove(field.name)} />}>
                                                                <Form.Item name={[field.name, "id"]} hidden>
                                                                    <Input />
                                                                </Form.Item>
                                                                <Row gutter={12}>
                                                                    <Col xs={24} md={7}>
                                                                        <Form.Item name={[field.name, "name"]} label="名称">
                                                                            <Input placeholder="视频生成 MCP" />
                                                                        </Form.Item>
                                                                    </Col>
                                                                    <Col xs={24} md={7}>
                                                                        <Form.Item name={[field.name, "transport"]} label="传输方式">
                                                                            <Select options={[{ label: "Streamable HTTP", value: "streamable_http" }, { label: "stdio 本地进程", value: "stdio" }]} />
                                                                        </Form.Item>
                                                                    </Col>
                                                                    <Col xs={12} md={5}>
                                                                        <Form.Item name={[field.name, "enabled"]} label="启用" valuePropName="checked">
                                                                            <Switch />
                                                                        </Form.Item>
                                                                    </Col>
                                                                    <Col xs={12} md={5}>
                                                                        <Form.Item name={[field.name, "allowUsers"]} label="允许普通用户" valuePropName="checked">
                                                                            <Switch />
                                                                        </Form.Item>
                                                                    </Col>
                                                                    {isStdio ? (
                                                                        <>
                                                                            <Col xs={24} md={12}>
                                                                                <Form.Item name={[field.name, "command"]} label="Command">
                                                                                    <Input placeholder="例如：video-mcp" />
                                                                                </Form.Item>
                                                                            </Col>
                                                                            <Col xs={24} md={12}>
                                                                                <Form.Item name={[field.name, "workingDirectory"]} label="工作目录">
                                                                                    <Input placeholder="可选，默认后端工作目录" />
                                                                                </Form.Item>
                                                                            </Col>
                                                                            <Col span={24}>
                                                                                <Form.Item name={[field.name, "argsText"]} label="Args" extra="每行一个参数">
                                                                                    <Input.TextArea rows={3} placeholder={"--port\n3000"} />
                                                                                </Form.Item>
                                                                            </Col>
                                                                            <Col span={24}>
                                                                                <Form.Item name={[field.name, "envJson"]} label="Env JSON">
                                                                                    <Input.TextArea rows={3} placeholder='{"API_KEY":"..."}' />
                                                                                </Form.Item>
                                                                            </Col>
                                                                        </>
                                                                    ) : (
                                                                        <>
                                                                            <Col xs={24} md={12}>
                                                                                <Form.Item name={[field.name, "endpoint"]} label="HTTP Endpoint">
                                                                                    <Input placeholder="https://example.com/mcp" />
                                                                                </Form.Item>
                                                                            </Col>
                                                                            <Col xs={24} md={12}>
                                                                                <Form.Item name={[field.name, "apiKey"]} label="API Key">
                                                                                    <Input.Password placeholder="留空沿用已保存的 Key" />
                                                                                </Form.Item>
                                                                            </Col>
                                                                        </>
                                                                    )}
                                                                    <Col span={24}>
                                                                        <Form.Item name={[field.name, "description"]} label="说明">
                                                                            <Input />
                                                                        </Form.Item>
                                                                    </Col>
                                                                    <Col span={24}>
                                                                        <Form.Item name={[field.name, "toolsJson"]} label={`工具定义 JSON（${server.tools?.length || 0}）`} extra="标准 MCP tools/list 返回的 tools 数组；也可以自动读取">
                                                                            <Input.TextArea rows={6} placeholder='[{"name":"generate_video","description":"生成视频","inputSchema":{"type":"object","properties":{}}}]' />
                                                                        </Form.Item>
                                                                        <Button loading={fetchingMCPToolsIndex === field.name} onClick={() => void loadMCPToolsAt(field.name)}>
                                                                            读取工具列表
                                                                        </Button>
                                                                    </Col>
                                                                </Row>
                                                            </Card>
                                                        );
                                                    })}
                                                </Flex>
                                            )}
                                        </Form.List>
                                    </Flex>
                                </Card>
                                <Card size="small" title="数据存储">
                                    <Row gutter={16}>
                                        <Col xs={24} md={6}>
                                            <Form.Item label="存储模式" extra="根据对象存储配置和启用状态自动识别。">
                                                <Input disabled value="自动识别 (动态切换)" />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "storage", "allowUserProvider"]} label="允许用户配置 S3/WebDAV" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "storage", "allowUserGlobalProvider"]} label="允许用户使用全局配置渠道" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={6}>
                                            <Form.Item name={["private", "storage", "autoSyncAllAssets"]} label="全部素材云端同步" extra="上传、导入及生成的图片、视频、音频自动同步到可用云存储；关闭保持原有行为" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "storage", "capacityCheck", "enabled"]} label="定时统计容量" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "storage", "capacityCheck", "cron"]} label="容量统计 Cron">
                                                <Input placeholder="0 */6 * * *" />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "storage", "capacityLimitBytes"]} label="容量上限(字节)" extra="默认 9GB，达到上限后会自动禁用该配置。">
                                                <InputNumber min={1} className="!w-full" />
                                            </Form.Item>
                                        </Col>
                                    </Row>
                                    <Form.List name={["private", "storage", "providers"]}>
                                        {(fields, { add, remove }) => (
                                            <Flex vertical gap={12}>
                                                <Button icon={<PlusOutlined />} onClick={() => add(newAdminStorageProvider("s3", storageProviders))}>
                                                    新增 S3/R2 配置
                                                </Button>
                                                <Button icon={<PlusOutlined />} onClick={() => add(newAdminStorageProvider("webdav", storageProviders))}>
                                                    新增 WebDAV 配置
                                                </Button>
                                                {fields.map((field) => {
                                                    const provider = storageProviders[field.name] || emptyS3StorageProvider;
                                                    const isWebDAV = provider.type === "webdav";
                                                    const weightField = (
                                                        <Col xs={24} md={3}>
                                                            <Form.Item name={[field.name, "weight"]} label="权重">
                                                                <InputNumber min={1} className="!w-full" />
                                                            </Form.Item>
                                                        </Col>
                                                    );
                                                    return (
                                                        <Card
                                                            key={field.key}
                                                            size="small"
                                                            title={isWebDAV ? "WebDAV" : "S3/R2"}
                                                            extra={
                                                                <Flex gap={8}>
                                                                    <Button size="small" loading={measuringProviderIndex === field.name} onClick={() => void measureStorageProviderAt(field.name)}>
                                                                        统计容量
                                                                    </Button>
                                                                    <Button danger size="small" icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                                                                </Flex>
                                                            }
                                                        >
                                                            <Form.Item name={[field.name, "type"]} hidden>
                                                                <Input />
                                                            </Form.Item>
                                                            <Row gutter={12}>
                                                                <Col xs={24} md={6}>
                                                                    <Form.Item name={[field.name, "name"]} label="名称">
                                                                        <Input placeholder={isWebDAV ? "WebDAV" : "Cloudflare R2"} />
                                                                    </Form.Item>
                                                                </Col>
                                                                <Col xs={24} md={isWebDAV ? 8 : 6}>
                                                                    <Form.Item name={[field.name, "endpoint"]} label={isWebDAV ? "WebDAV 地址" : "Endpoint"}>
                                                                        <Input placeholder={isWebDAV ? "https://dav.example.com/webdav" : "https://<account>.r2.cloudflarestorage.com"} />
                                                                    </Form.Item>
                                                                </Col>
                                                                {!isWebDAV && (
                                                                    <>
                                                                        <Col xs={24} md={4}>
                                                                            <Form.Item name={[field.name, "region"]} label="Region">
                                                                                <Input placeholder="auto" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={4}>
                                                                            <Form.Item name={[field.name, "bucket"]} label="Bucket">
                                                                                <Input />
                                                                            </Form.Item>
                                                                        </Col>
                                                                    </>
                                                                )}
                                                                <Col xs={24} md={4}>
                                                                    <Form.Item name={[field.name, "enabled"]} label="启用" valuePropName="checked">
                                                                        <Switch
                                                                            onChange={(checked) => {
                                                                                if (!checked) return;
                                                                                const providers = form.getFieldValue(["private", "storage", "providers"]) || [];
                                                                                const type = form.getFieldValue(["private", "storage", "providers", field.name, "type"]);
                                                                                providers.forEach((item: AdminStorageProvider, i: number) => {
                                                                                    if (i !== field.name && item.type !== type) {
                                                                                        form.setFieldValue(["private", "storage", "providers", i, "enabled"], false);
                                                                                    }
                                                                                });
                                                                            }}
                                                                        />
                                                                    </Form.Item>
                                                                </Col>
                                                                {isWebDAV && weightField}
                                                                {isWebDAV ? (
                                                                    <>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "pathPrefix"]} label="远程目录">
                                                                                <Input placeholder="请输入远程目录" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "username"]} label="用户名">
                                                                                <Input />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "password"]} label="密码 / 应用密码">
                                                                                <Input.Password placeholder="留空沿用已保存密码" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={0} md={6} />
                                                                    </>
                                                                ) : (
                                                                    <>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "accessKeyId"]} label="Access Key ID">
                                                                                <Input />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "secretAccessKey"]} label="Secret Access Key">
                                                                                <Input.Password placeholder="留空沿用已保存密钥" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={6}>
                                                                            <Form.Item name={[field.name, "publicBaseUrl"]} label="公开访问域名">
                                                                                <Input placeholder="可选，不填则走后端代理读取" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        <Col xs={24} md={3}>
                                                                            <Form.Item name={[field.name, "pathPrefix"]} label="路径前缀">
                                                                                <Input placeholder="canvas" />
                                                                            </Form.Item>
                                                                        </Col>
                                                                        {weightField}
                                                                    </>
                                                                )}
                                                                <Col xs={24} md={4}>
                                                                    <Form.Item label="已用容量">
                                                                        <Typography.Text>{formatStorageBytes(form.getFieldValue(["private", "storage", "providers", field.name, "capacityBytes"]) || 0)}</Typography.Text>
                                                                    </Form.Item>
                                                                </Col>
                                                                <Col xs={24} md={5}>
                                                                    <Form.Item name={[field.name, "capacityCheckedAt"]} label="统计时间">
                                                                        <Input disabled />
                                                                    </Form.Item>
                                                                </Col>
                                                                <Col xs={24} md={3}>
                                                                    <Form.Item name={[field.name, "capacityExceeded"]} label="超限" valuePropName="checked">
                                                                        <Switch disabled />
                                                                    </Form.Item>
                                                                </Col>
                                                            </Row>
                                                        </Card>
                                                    );
                                                })}
                                            </Flex>
                                        )}
                                    </Form.List>
                                </Card>
                                <Button type="primary" icon={<PlusOutlined />} onClick={() => openChannelDrawer(null)}>
                                    新增渠道
                                </Button>
                                <Table
                                    rowKey="_rowKey"
                                    pagination={false}
                                    dataSource={channelTableData}
                                    columns={[
                                        { title: "名称", dataIndex: "name", render: (value) => value || "未命名渠道" },
                                        { title: "协议", dataIndex: "protocol", width: 96, render: (value) => <Tag>{value || "openai"}</Tag> },
                                        { title: "状态", dataIndex: "enabled", width: 120, render: (value, item) => isWorkflowProtocol(item.protocol) ? <Tag>{`启用 ${(item.workflows || []).filter((entry) => entry.enabled).length} / ${(item.workflows || []).length} 条`}</Tag> : <Tag color={value ? "success" : "default"}>{value ? "已启用" : "已停用"}</Tag> },
                                        {
                                            title: "模型",
                                            dataIndex: "models",
                                            render: (value: string[], item) => (
                                                <Typography.Text ellipsis style={{ maxWidth: 360 }}>
                                                    {isWorkflowProtocol(item.protocol) ? (item.workflows || []).map((entry) => entry.title || entry.workflowId).join("、") || "未配置工作流" : modelSummary(value || [])}
                                                </Typography.Text>
                                            ),
                                        },
                                        { title: "权重", dataIndex: "weight", width: 88 },
                                        { title: "超时", dataIndex: "timeout", width: 96, render: (value) => `${value || 600}s` },
                                        {
                                            title: "操作",
                                            key: "actions",
                                            width: 220,
                                            render: (_, item) => (
                                                <Space size={4}>
                                                    {!isWorkflowProtocol(item.protocol) ? <Button size="small" onClick={() => openTestDialog(item._index)}>测试</Button> : null}
                                                    <Button size="small" onClick={() => openChannelDrawer(item._index)}>
                                                        编辑
                                                    </Button>
                                                    <Button
                                                        danger
                                                        size="small"
                                                        icon={<DeleteOutlined />}
                                                        onClick={() => {
                                                            const nextChannels = [...channels];
                                                            nextChannels.splice(item._index, 1);
                                                            void persistChannels(nextChannels);
                                                        }}
                                                    />
                                                </Space>
                                            ),
                                        },
                                    ]}
                                />
                            </Flex>
                        </Form>
                    ) : (
                        <div style={{ overflow: "hidden", border: "1px solid var(--ant-color-border)", borderRadius: 6 }}>
                            <CodeMirror
                                value={activeJsonText}
                                height="520px"
                                extensions={[json(), jsonEditorTheme]}
                                basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true, highlightActiveLineGutter: true }}
                                theme="none"
                                onChange={(value) => setJsonText((current) => ({ ...current, private: value }))}
                                style={{ fontSize: 13 }}
                            />
                        </div>
                    )}
                </Card>
                <Drawer
                    title={editingChannelIndex === null ? "新增渠道" : "编辑渠道"}
                    open={isChannelDrawerOpen}
                    size={isWorkflowProtocol(channelProtocol) ? "75vw" : 760}
                    onClose={closeChannelDrawer}
                    extra={
                        <Space>
                            <Button onClick={closeChannelDrawer}>取消</Button>
                            <Button type="primary" onClick={() => void saveChannel()}>
                                保存
                            </Button>
                        </Space>
                    }
                    destroyOnHidden
                >
                    <Form form={channelForm} layout="vertical" requiredMark={false} initialValues={emptyChannel}>
                        <Row gutter={16}>
                            <Col span={12}>
                                <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: "请输入渠道名称" }]}>
                                    <Input />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="protocol" label="协议">
                                    <Select
                                        options={modelChannelProtocolOptions}
                                        onChange={(protocol: AdminModelChannel["protocol"]) => {
                                            channelForm.setFieldValue("baseUrl", modelChannelDefaultBaseUrls[protocol]);
                                            setWorkflowChannelDraft((current) => ({ ...current, protocol, baseUrl: modelChannelDefaultBaseUrls[protocol] }));
                                        }}
                                    />
                                </Form.Item>
                            </Col>
                            {!isWorkflowProtocol(channelProtocol) ? <>
                            <Col span={12}>
                                <Form.Item name="weight" label="权重">
                                    <InputNumber min={1} step={1} className="!w-full" />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="timeout" label="请求超时（秒）" extra="用于后台代理请求、模型列表读取和渠道测试">
                                    <InputNumber min={1} step={30} className="!w-full" />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="enabled" label="启用" valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item
                                    name="baseUrl"
                                    label={
                                        <span className="relative inline-flex items-center">
                                            接口地址
                                            {channelApiKeyUrl ? (
                                                <span className="absolute left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap">
                                                    <Button type="primary" size="small" href={channelApiKeyUrl} target="_blank">
                                                        获取 API Key
                                                    </Button>
                                                </span>
                                            ) : null}
                                        </span>
                                    }
                                    rules={[{ required: true, message: "请输入接口地址" }]}
                                >
                                    <Input />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item name="apiKey" label="API Key" rules={editingChannelIndex === null ? [{ required: true, message: "请输入 API Key" }] : []}>
                                    <Input.Password placeholder={editingChannelIndex === null ? "" : "留空则沿用已保存的 API Key"} />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item label="渠道可用模型" extra="由下方映射表推导出的请求模型名称；请直接编辑映射表，避免两个入口互相覆盖。">
                                    <Typography.Text type="secondary">{selectedChannelModels.join("、") || "未配置模型"}</Typography.Text>
                                    <Button type="link" onClick={() => openChannelModelSelector()}>选择模型</Button>
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item label="模型映射">
                                    <ModelMappingEditor rows={modelMappingRows} requestModels={uniqueModels([...rawSelectedChannelModels, ...selectedChannelModels])} upstreamModels={uniqueModels([...channelUpstreamModels, ...knownModels])} onChange={updateModelMappingRows} onCommit={() => commitModelMappingRows(modelMappingRows)} onRemove={removeModelMapping} onAdd={addModelMapping} />
                                </Form.Item>
                            </Col>
                            {selectedChannelModels.length ? (
                                <Col span={24}>
                                    <Form.Item label="模型能力声明（可选）" extra="自动推导按协议和模型名估算，自定义模型请手动声明。取消全部勾选表示无可用能力；点击自动推导可移除声明。">
                                        <Flex vertical gap={10}>
                                            <Flex align="center" gap={8} wrap>
                                                <Select
                                                    mode="multiple"
                                                    allowClear
                                                    maxTagCount="responsive"
                                                    placeholder="选择要批量修改的模型"
                                                    value={bulkTargetModels}
                                                    onChange={setBulkTargetModels}
                                                    options={selectedChannelModels.map((model: string) => ({ label: model, value: model }))}
                                                    style={{ minWidth: 260, maxWidth: "100%" }}
                                                />
                                                <Checkbox.Group options={modelCapabilityOptions} value={bulkModelCapabilities} onChange={(values) => setBulkModelCapabilities(uniqueCapabilities(values as ModelCapability[]))} />
                                                <Button size="small" disabled={!bulkTargetModels.length} onClick={applyBulkModelCapabilities}>
                                                    {bulkModelCapabilities.length ? `应用到 ${bulkTargetModels.length} 个模型` : `清除 ${bulkTargetModels.length} 个模型声明`}
                                                </Button>
                                            </Flex>
                                            <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--ant-color-border-secondary)", borderRadius: 6, padding: "4px 10px" }}>
                                                {selectedChannelModels.map((model: string) => {
                                                    const declared = channelModelCapabilities[model];
                                                    const automatic = !Array.isArray(declared);
                                                    const capabilities = automatic
                                                        ? modelCapabilityOptions.filter(({ value }) => modelMatchesCapability(model, value, channelProtocol, channelModelCapabilities, channelModelMap)).map(({ value }) => value)
                                                        : declared;
                                                    return (
                                                        <Flex key={model} justify="space-between" align="center" gap={12} wrap style={{ minHeight: 38, borderBottom: "1px solid var(--ant-color-border-secondary)" }}>
                                                            <Typography.Text ellipsis title={model} style={{ flex: "1 1 150px", minWidth: 120 }}>{model}</Typography.Text>
                                                            <Button size="small" type="text" title="移除手动声明，恢复按协议和模型名推导" aria-label={`${model} 恢复自动推导`} onClick={() => updateChannelModelCapabilities(model)}>
                                                                {automatic ? "自动推导" : "恢复自动推导"}
                                                            </Button>
                                                            <Checkbox.Group
                                                                options={modelCapabilityOptions}
                                                                value={capabilities}
                                                                onChange={(values) => updateChannelModelCapabilities(model, values as ModelCapability[])}
                                                            />
                                                        </Flex>
                                                    );
                                                })}
                                            </div>
                                        </Flex>
                                    </Form.Item>
                                </Col>
                            ) : null}
                            {selectedChannelModels.length ? (
                                <Col span={24}>
                                    <Form.Item label="图片质量能力声明（可选）" extra="不声明时保持原样透传；启用后填写上游允许值，留空表示不支持 quality。映射与默认值只能选择允许值。">
                                        <Collapse size="small" items={selectedChannelModels.map((model: string) => {
                                            const capability: ImageQualityCapability | undefined = channelImageQualityCapabilities[model];
                                            const options = (capability?.values || []).map((value) => ({ label: value, value }));
                                            return {
                                                key: model,
                                                label: model,
                                                extra: <Tag>{capability ? "已声明" : "原样透传"}</Tag>,
                                                children: (
                                                    <Flex vertical gap={10}>
                                                        <Flex align="center" gap={8}>
                                                            <Switch aria-label={`${model} 启用质量声明`} checked={Boolean(capability)} onChange={(enabled) => updateChannelImageQualityCapability(model, enabled ? { values: [] } : undefined)} />
                                                            <Typography.Text>启用质量声明</Typography.Text>
                                                        </Flex>
                                                        {capability ? <>
                                                            <Typography.Text>上游允许的质量值</Typography.Text>
                                                            <Select
                                                                mode="tags"
                                                                aria-label={`${model} 上游质量允许值`}
                                                                placeholder="输入允许值，例如 low、high、auto"
                                                                tokenSeparators={[",", "\n"]}
                                                                value={capability.values}
                                                                options={IMAGE_QUALITY_OPTIONS.map(({ value, label }) => ({ value, label: `${label}（${value}）` }))}
                                                                onChange={(values) => updateChannelImageQualityCapability(model, { ...capability, values })}
                                                            />
                                                            <Typography.Text>六档质量映射</Typography.Text>
                                                            <Typography.Text type="secondary">允许值直接透传；其余档位先使用映射，再使用默认值。</Typography.Text>
                                                            <Row gutter={[12, 8]}>
                                                                {IMAGE_QUALITY_OPTIONS.map(({ value, label }) => (
                                                                    <Col span={12} key={value}>
                                                                        <Flex vertical gap={4}>
                                                                            <Typography.Text type="secondary">{label}（{value}）</Typography.Text>
                                                                            <Select
                                                                                aria-label={`${model} ${value} 映射`}
                                                                                allowClear
                                                                                placeholder="未映射"
                                                                                options={options}
                                                                                value={capability.map?.[value]}
                                                                                onChange={(target) => updateChannelImageQualityCapability(model, { ...capability, map: { ...capability.map, [value]: target || "" } })}
                                                                            />
                                                                        </Flex>
                                                                    </Col>
                                                                ))}
                                                            </Row>
                                                            <Typography.Text>无法匹配时的默认值</Typography.Text>
                                                            <Select
                                                                aria-label={`${model} 质量默认值`}
                                                                allowClear
                                                                placeholder="未设置时省略质量参数"
                                                                options={options}
                                                                value={capability.defaultValue}
                                                                onChange={(defaultValue) => updateChannelImageQualityCapability(model, { ...capability, defaultValue })}
                                                            />
                                                        </> : null}
                                                    </Flex>
                                                ),
                                            };
                                        })} />
                                    </Form.Item>
                                </Col>
                            ) : null}
                            {selectedChannelModels.length ? (
                                <Col span={24}>
                                    <Form.Item label="图片输出格式声明（可选）" extra="未声明时保持自动透传；启用后仅发送所选格式，默认格式必须属于允许格式。留空表示明确不支持格式。">
                                        <Collapse size="small" items={selectedChannelModels.map((model: string) => {
                                            const capability: ImageOutputCapability | undefined = channelImageOutputCapabilities[model];
                                            const options = imageOutputFormatOptions.map(({ value, label }) => ({ value, label }));
                                            return {
                                                key: model,
                                                label: model,
                                                extra: <Tag>{capability ? (capability.formats.length ? "已声明" : "明确不支持") : "未声明"}</Tag>,
                                                children: (
                                                    <Flex vertical gap={10}>
                                                        <Flex align="center" gap={8}>
                                                            <Switch aria-label={`${model} 启用输出格式声明`} checked={Boolean(capability)} onChange={(enabled) => updateChannelImageOutputCapability(model, enabled ? { formats: [] } : undefined)} />
                                                            <Typography.Text>启用输出格式声明</Typography.Text>
                                                        </Flex>
                                                        {capability ? <>
                                                            <Typography.Text>上游允许的图片格式</Typography.Text>
                                                            <Checkbox.Group
                                                                aria-label={`${model} 上游图片格式`}
                                                                options={options}
                                                                value={capability.formats}
                                                                onChange={(formats) => updateChannelImageOutputCapability(model, { ...capability, formats: formats as ImageOutputCapability["formats"] })}
                                                            />
                                                            <Typography.Text>默认格式</Typography.Text>
                                                            <Select
                                                                aria-label={`${model} 图片默认格式`}
                                                                allowClear
                                                                placeholder="未设置时保持自动透传"
                                                                options={options.filter(({ value }) => capability.formats.includes(value))}
                                                                value={capability.defaultFormat}
                                                                onChange={(defaultFormat) => updateChannelImageOutputCapability(model, { ...capability, defaultFormat })}
                                                            />
                                                        </> : null}
                                                    </Flex>
                                                ),
                                            };
                                        })} />
                                    </Form.Item>
                                </Col>
                            ) : null}
                            </> : <Col span={24} className="mb-3">
                                <WorkflowChannelPane
                                    key={`${editingChannelIndex ?? "new"}:${workflowChannelDraft.id}:${workflowChannelDraft.protocol}`}
                                    channel={workflowChannelDraft as WorkflowChannelSettings}
                                    workflows={workflowChannelDraft.workflows || []}
                                    token={token || ""}
                                    admin={{ index: editingChannelIndex ?? undefined, channel: workflowChannelDraft }}
                                    onChannelChange={(patch) => { channelForm.setFieldsValue(patch); setWorkflowChannelDraft((current) => ({ ...current, ...patch })); }}
                                    onBridgeDeleted={(bridgeId) => {
                                        const nextChannels = channels.map((channel) => channel.protocol === "comfyui" && channel.bridgeId === bridgeId ? { ...channel, bridgeId: "" } : channel);
                                        setChannels(nextChannels);
                                        form.setFieldValue(["private", "channels"], nextChannels);
                                        channelForm.setFieldValue("bridgeId", "");
                                        setWorkflowChannelDraft((current) => current.bridgeId === bridgeId ? { ...current, bridgeId: "" } : current);
                                    }}
                                    onWorkflowsChange={(workflows) => { channelForm.setFieldValue("workflows", workflows); setWorkflowChannelDraft((current) => ({ ...current, workflows })); }}
                                    onBeforeTest={async () => {
                                        const saved = editingChannelIndex === null ? undefined : channels[editingChannelIndex];
                                        if (!saved?.id) throw new Error("请先保存渠道后再测试");
                                        const draft = normalizeChannel({ ...workflowChannelDraft, ...channelForm.getFieldsValue(true) });
                                        if (JSON.stringify(draft) !== JSON.stringify(normalizeChannel(saved))) throw new Error("当前配置有未保存修改，请先保存后再测试");
                                        return saved.id;
                                    }}
                                />
                            </Col>}
                            <Col span={24}>
                                <Form.Item name="remark" label="备注">
                                    <Input.TextArea rows={3} />
                                </Form.Item>
                            </Col>
                        </Row>
                    </Form>
                </Drawer>
                {isModelSelectorOpen ? (
                    <ChannelModelSelectorModal
                        channel={channelForm.getFieldsValue()}
                        models={modelMappingRows.map((item) => item.upstreamName.trim() || item.requestName.trim()).filter(Boolean)}
                        sourceModels={channelUpstreamModels}
                        onCancel={closeChannelModelSelector}
                        onConfirm={confirmChannelModelSelector}
                        onFetchModels={fetchChannelModelList}
                        onModelsFetched={(models) => { setChannelUpstreamModels((current) => uniqueModels([...current, ...models])); rememberModels(models); }}
                    />
                ) : null}
                <Modal
                    title={
                        <Space>
                            {testChannel?.name || "渠道"} 渠道的模型测试<Typography.Text type="secondary">共 {testChannel?.models.length || 0} 个模型</Typography.Text>
                        </Space>
                    }
                    open={testChannelIndex !== null}
                    width={920}
                    onCancel={closeTestDialog}
                    footer={
                        <Space>
                            <Button onClick={closeTestDialog}>取消</Button>
                            <Button type="primary" disabled={!selectedTestModels.length || testingModels.length > 0} onClick={() => void batchTestModels()}>
                                批量测试 {selectedTestModels.length} 个模型
                            </Button>
                        </Space>
                    }
                    destroyOnHidden
                >
                    <Flex vertical gap={12}>
                        <Typography.Text type="secondary">测试会向选中模型发送最小测试请求，用于确认渠道是否有响应。</Typography.Text>
                        <Input.Search placeholder="搜索模型..." allowClear value={testKeyword} onChange={(event) => setTestKeyword(event.target.value)} />
                        <Table
                            rowKey="model"
                            pagination={false}
                            scroll={{ y: 420 }}
                            dataSource={testModels.map((model) => ({ model }))}
                            rowSelection={{
                                selectedRowKeys: selectedTestModels,
                                onChange: (keys) => setSelectedTestModels(keys.map(String)),
                            }}
                            columns={[
                                { title: "模型名称", dataIndex: "model", render: (value) => <Typography.Text strong title={value}>{modelLabel(value, testChannel)}</Typography.Text> },
                                {
                                    title: "状态",
                                    dataIndex: "model",
                                    width: 260,
                                    render: (value) => {
                                        if (testingModels.includes(value)) return <Tag icon={<LoadingOutlined className="animate-spin" />}>测试中</Tag>;
                                        const result = testResults[value];
                                        if (!result) return <Tag>未开始</Tag>;
                                        return result.status === "success" ? (
                                            <Space size={6} wrap>
                                                <Tag color="success">成功</Tag>
                                                <Typography.Text type="secondary">请求时长: {result.duration}</Typography.Text>
                                                {result.message && result.message !== "ok" ? <Typography.Text type="secondary">{result.message}</Typography.Text> : null}
                                            </Space>
                                        ) : (
                                            <Typography.Text type="danger">{result.message}</Typography.Text>
                                        );
                                    },
                                },
                                {
                                    title: "操作",
                                    key: "actions",
                                    width: 120,
                                    render: (_, item) => (
                                        <Button size="small" loading={testingModels.includes(item.model)} onClick={() => void testModelOnline(item.model)}>
                                            测试
                                        </Button>
                                    ),
                                },
                            ]}
                        />
                    </Flex>
                </Modal>
            </Flex>
        </main>
    );
}

function normalizeSettings(settings: Partial<AdminSettings> = {}): AdminSettings {
    const privateSetting = normalizePrivateSetting(settings.private);
    return {
        public: {
            ...normalizePublicSetting(settings.public),
        },
        private: privateSetting,
    };
}

function normalizePublicSetting(setting: Partial<AdminSettings["public"]> = {}): AdminSettings["public"] {
    return {
        ...emptySettings.public,
        modelChannel: {
            ...emptySettings.public.modelChannel,
            ...(setting.modelChannel || {}),
            availableModels: setting.modelChannel?.availableModels || [],
            availableWorkflows: setting.modelChannel?.availableWorkflows || [],
            modelCosts: normalizeModelCosts(setting.modelChannel?.modelCosts || []),
            channels: setting.modelChannel?.channels || [],
            systemPrompts: {
                ...emptySettings.public.modelChannel.systemPrompts,
                image: setting.modelChannel?.systemPrompts?.image || setting.modelChannel?.systemPrompt || "",
                video: setting.modelChannel?.systemPrompts?.video || "",
                text: setting.modelChannel?.systemPrompts?.text || setting.modelChannel?.systemPrompt || "",
                workflow: setting.modelChannel?.systemPrompts?.workflow || "",
                workflowAgent: setting.modelChannel?.systemPrompts?.workflowAgent || "",
            },
        },
        auth: {
            allowRegister: setting.auth?.allowRegister !== false,
            linuxDo: {
                enabled: setting.auth?.linuxDo?.enabled === true,
            },
        },
        storage: {
            mode: setting.storage?.mode || "local_indexeddb",
            allowUserProvider: setting.storage?.allowUserProvider === true,
            allowUserGlobalProvider: setting.storage?.allowUserGlobalProvider === true,
            autoSyncAllAssets: setting.storage?.autoSyncAllAssets === true,
        },
    };
}

function normalizeModelCosts(items: Partial<AdminSettings["public"]["modelChannel"]["modelCosts"][number]>[]) {
    return items.filter((item) => item.model).map((item) => ({ ...(item.channelId ? { channelId: item.channelId } : {}), model: item.model || "", credits: Math.max(0, Number(item.credits) || 0) }));
}

function normalizePrivateSetting(setting: Partial<AdminSettings["private"]> = {}): AdminSettings["private"] {
    return {
        channels: (setting.channels || []).map(normalizeChannel),
        agent: {
            mcpServers: (setting.agent?.mcpServers || []).map(normalizeMCPServer),
        },
        promptSync: {
            enabled: setting.promptSync?.enabled !== false,
            cron: setting.promptSync?.cron || "0 0 * * *",
        },
        aiLog: {
            localDirectReportEnabled: setting.aiLog?.localDirectReportEnabled === true,
            cleanup: {
                enabled: setting.aiLog?.cleanup?.enabled === true,
                retentionDays: Number(setting.aiLog?.cleanup?.retentionDays) || 14,
                cron: setting.aiLog?.cleanup?.cron || "0 3 * * *",
            },
        },
        auth: {
            linuxDo: {
                clientId: setting.auth?.linuxDo?.clientId || "",
                clientSecret: setting.auth?.linuxDo?.clientSecret || "",
            },
        },
        storage: {
            mode: setting.storage?.mode || "local_indexeddb",
            allowUserProvider: setting.storage?.allowUserProvider === true,
            allowUserGlobalProvider: setting.storage?.allowUserGlobalProvider === true,
            autoSyncAllAssets: setting.storage?.autoSyncAllAssets === true,
            providers: (setting.storage?.providers || []).map(normalizeStorageProvider),
            roundRobinCursor: Number(setting.storage?.roundRobinCursor) || 0,
            capacityCheck: {
                enabled: setting.storage?.capacityCheck?.enabled === true,
                cron: setting.storage?.capacityCheck?.cron || "0 */6 * * *",
            },
            capacityLimitBytes: Number(setting.storage?.capacityLimitBytes) || 9 * 1024 * 1024 * 1024,
        },
    };
}

function normalizeMCPServer(item: Partial<AdminMCPServer> = {}): AdminMCPServer {
    const tools = typeof item.toolsJson === "string" && item.toolsJson.trim() ? parseMCPTools(item.toolsJson, item.tools || []) : (item.tools || []).map(normalizeMCPTool);
    const args = typeof item.argsText === "string" ? item.argsText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) : item.args || [];
    const env = typeof item.envJson === "string" && item.envJson.trim() ? parseMCPEnv(item.envJson, item.env || {}) : item.env || {};
    return {
        ...emptyMCPServer,
        ...item,
        id: item.id || "",
        name: item.name || "",
        description: item.description || "",
        tools,
        endpoint: item.endpoint || "",
        apiKey: item.apiKey || "",
        transport: item.transport === "stdio" ? "stdio" : "streamable_http",
        command: item.command || "",
        args,
        env,
        workingDirectory: item.workingDirectory || "",
        toolsJson: JSON.stringify(tools, null, 2),
        argsText: args.join("\n"),
        envJson: JSON.stringify(env, null, 2),
        enabled: item.enabled !== false,
        allowUsers: item.allowUsers !== false,
    };
}

function parseMCPTools(value: string, fallback: Partial<AdminMCPTool>[] = []): AdminMCPTool[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(normalizeMCPTool).filter((item) => item.name) : [];
    } catch {
        return fallback.map(normalizeMCPTool);
    }
}

function parseMCPEnv(value: string, fallback: Record<string, string> = {}) {
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
        return Object.fromEntries(Object.entries(parsed).filter(([, item]) => typeof item === "string")) as Record<string, string>;
    } catch {
        return fallback;
    }
}

function normalizeMCPTool(item: Partial<AdminMCPTool> = {}): AdminMCPTool {
    return { name: item.name || "", description: item.description || "", inputSchema: item.inputSchema && typeof item.inputSchema === "object" ? item.inputSchema : {} };
}

function normalizeStorageProvider(item: Partial<AdminStorageProvider> = {}): AdminStorageProvider {
    const type = item.type === "webdav" ? "webdav" : "s3";
    return {
        ...(type === "webdav" ? emptyWebDAVStorageProvider : emptyS3StorageProvider),
        ...item,
        id: item.id || "",
        type,
        region: type === "s3" ? item.region || "auto" : "",
        weight: Math.max(1, Number(item.weight) || 1),
        enabled: item.enabled !== false,
        capacityBytes: Number(item.capacityBytes) || 0,
        capacityCheckedAt: item.capacityCheckedAt || "",
        capacityExceeded: item.capacityExceeded === true,
    };
}

function newAdminStorageProvider(type: AdminStorageProvider["type"], providers: AdminStorageProvider[]) {
    const template = type === "webdav" ? emptyWebDAVStorageProvider : emptyS3StorageProvider;
    return {
        ...template,
        enabled: !providers.some((provider) => provider.enabled && provider.type !== type),
    };
}

function normalizeChannel(item: Partial<AdminModelChannel> = {}): AdminModelChannel {
    const models = uniqueModels([...(item.models || []), ...Object.keys(item.modelMap || {})]);
    return {
        id: item.id || "",
        protocol: item.protocol || "openai",
        name: item.name || "",
        baseUrl: item.baseUrl || "",
        apiKey: item.apiKey || "",
        models,
        modelMap: normalizeModelMap(item.modelMap, models),
        modelCapabilities: normalizeModelCapabilities(item.modelCapabilities, models),
        imageOutputCapabilities: normalizeImageOutputCapabilities(item.imageOutputCapabilities, models),
        imageQualityCapabilities: normalizeImageQualityCapabilities(item.imageQualityCapabilities, models),
        uploadApiKey: item.uploadApiKey || "",
        bridgeId: item.bridgeId || "",
        comfyUrl: item.comfyUrl || "",
        workflowDir: item.workflowDir || "",
        workflows: item.workflows || [],
        weight: Math.max(1, Number(item.weight) || 1),
        timeout: Math.max(1, Number(item.timeout) || 600),
        enabled: item.enabled !== false,
        remark: item.remark || "",
    };
}

function normalizeModelCapabilities(capabilities: AdminModelChannel["modelCapabilities"], models: string[]) {
    if (!capabilities) return undefined;
    const modelSet = new Set(models);
    const result: NonNullable<AdminModelChannel["modelCapabilities"]> = {};
    for (const [model, values] of Object.entries(capabilities)) {
        if (modelSet.has(model) && Array.isArray(values)) result[model] = uniqueCapabilities(values);
    }
    return Object.keys(result).length ? result : undefined;
}

function renameChannelModel(channel: Partial<AdminModelChannel>, oldModel: string, newModel: string): AdminModelChannel {
    const oldName = oldModel.trim();
    const nextName = newModel.trim();
    if (!nextName || oldName === nextName) return channel as AdminModelChannel;
    const replaceKey = <T,>(values?: Record<string, T>) => {
        if (!values) return values;
        const next = { ...values };
        if (Object.prototype.hasOwnProperty.call(next, oldName)) {
            next[nextName] = next[oldName];
            delete next[oldName];
        }
        return next;
    };
    return {
        ...channel,
        models: uniqueModels([...(channel.models || []).map((model) => model === oldName ? nextName : model), ...Object.keys(channel.modelMap || {}).map((model) => model === oldName ? nextName : model)]),
        modelMap: replaceKey(channel.modelMap),
        modelCapabilities: replaceKey(channel.modelCapabilities),
        imageQualityCapabilities: replaceKey(channel.imageQualityCapabilities),
        imageOutputCapabilities: replaceKey(channel.imageOutputCapabilities),
    } as AdminModelChannel;
}

function applyModelMappingRows(channel: Partial<AdminModelChannel>, rows: ModelMappingRow[], previousRows: ModelMappingRow[]): AdminModelChannel {
    let next = { ...channel };
    for (const previous of previousRows) {
        const current = rows.find((row) => row.id === previous.id);
        const oldName = previous.requestName.trim() || previous.upstreamName.trim();
        const newName = current && (current.requestName.trim() || current.upstreamName.trim());
        if (oldName && newName && oldName !== newName) next = renameChannelModel(next, oldName, newName);
    }
    // The table is the sole source of models/modelMap; normalize only after replacing both.
    return normalizeChannel({ ...next, ...deriveModelMapping(rows) });
}

function normalizeModelMap(mapping: AdminModelChannel["modelMap"], models: string[]) {
    const entries = uniqueModels([...models, ...Object.keys(mapping || {})]).flatMap(model => {
        const value = mapping?.[model];
        const upstream = typeof value === "string" ? value.trim() : "";
        return upstream ? [[model, upstream]] : [];
    });
    return entries.length ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

function uniqueCapabilities(values: ModelCapability[] = []) {
    return Array.from(new Set(values.filter((value): value is ModelCapability => modelCapabilityOptions.some((option) => option.value === value))));
}

function modelCostCredits(items: AdminSettings["public"]["modelChannel"]["modelCosts"], channelId: string, model: string) {
    const scoped = items.find((item) => item.model === model && item.channelId === channelId);
    if (scoped) return scoped.credits;
    return items.find((item) => item.model === model && !item.channelId)?.credits || 0;
}

function setModelCost(form: any, setModelCosts: (items: AdminModelCost[]) => void, channelId: string, model: string, credits: number) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCosts"]) || []) as AdminSettings["public"]["modelChannel"]["modelCosts"];
    const next = current.filter((item) => !(item.model === model && item.channelId === channelId));
    next.push({ ...(channelId ? { channelId } : {}), model, credits: Math.max(0, credits) });
    form.setFieldValue(["public", "modelChannel", "modelCosts"], next);
    setModelCosts(next);
}

function mergeChannelApiKeys(currentChannels: AdminModelChannel[], saved: AdminSettings): AdminSettings {
    const channels = saved.private.channels.map((item, index) => {
        const source = isWorkflowProtocol(item.protocol) ? currentChannels.find((channel) => channel.id === item.id && channel.protocol === item.protocol) : currentChannels[index];
        return { ...item, apiKey: source?.apiKey || item.apiKey, uploadApiKey: source?.uploadApiKey || item.uploadApiKey };
    });
    return {
        public: saved.public,
        private: { ...saved.private, channels },
    };
}

function resolveAvailableModels(availableModels: string[], channels: AdminModelChannel[], autoAddMappingKeys: string[] = []) {
    const enabledModels = collectChannelModels(channels);
    const autoAdd = new Set(autoAddMappingKeys);
    return uniqueModels([...filterModels(availableModels, enabledModels), ...enabledModels.filter((model) => autoAdd.has(model))]);
}

function collectChannelModels(channels: AdminModelChannel[]) {
    return uniqueModels(channels.filter((channel) => !isWorkflowProtocol(channel.protocol)).flatMap((channel) => channel.models || []));
}

function collectChannelWorkflows(channels: AdminModelChannel[]) {
    return channels.flatMap((channel) => isWorkflowProtocol(channel.protocol) ? (channel.workflows || []).filter((entry) => entry.enabled && entry.provider === channel.protocol).map((entry) => ({ label: `${channel.name} · ${entry.title || entry.workflowId}（工作流）`, value: `workflow:system:${channel.id}:${entry.kind}:${entry.workflowId}` })) : []);
}

function collectKnownModels(settings: AdminSettings) {
    return uniqueModels([...(settings.public.modelChannel.availableModels || []), ...(settings.public.modelChannel.modelCosts || []).map((item) => item.model), ...settings.private.channels.flatMap((channel) => channel.models || [])]);
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.filter(Boolean)));
}

function filterModels(models: string[], options: string[]) {
    const optionSet = new Set(options);
    return uniqueModels(models).filter((model) => optionSet.has(model));
}

function modelSummary(models: string[]) {
    if (!models.length) return "未配置模型";
    const preview = models.slice(0, 3).join(", ");
    return models.length > 3 ? `${models.length} 个模型：${preview}...` : preview;
}

function formatStorageBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function parseTabJson(tab: "public", value: string): AdminSettings["public"] | null;
function parseTabJson(tab: "private", value: string): AdminSettings["private"] | null;
function parseTabJson(tab: SettingsTabKey, value: string): AdminSettings[SettingsTabKey] | null;
function parseTabJson(tab: SettingsTabKey, value: string): AdminSettings[SettingsTabKey] | null {
    try {
        return tab === "public" ? normalizePublicSetting(JSON.parse(value) as Partial<AdminSettings["public"]>) : normalizePrivateSetting(JSON.parse(value) as Partial<AdminSettings["private"]>);
    } catch {
        return null;
    }
}

async function collectSettings(form: any, editorMode: Record<SettingsTabKey, EditorMode>, jsonText: Record<SettingsTabKey, string>, message: { error: (value: string) => void }, savedRequestNames: string[] = [], savedGroups?: AdminSettings["public"]["modelChannel"]["userGroups"]) {
    const values = normalizeSettings(form.getFieldsValue(true) as AdminSettings);
    if (editorMode.public === "json") {
        const publicSetting = parseTabJson("public", jsonText.public);
        if (!publicSetting) {
            message.error("公开配置 JSON 格式不正确");
            return null;
        }
        values.public = publicSetting;
    }
    if (editorMode.private === "json") {
        const privateSetting = parseTabJson("private", jsonText.private);
        if (!privateSetting) {
            message.error("私有配置 JSON 格式不正确");
            return null;
        }
        values.private = privateSetting;
    }
    const newlyAddedRequestNames = collectChannelModels(values.private.channels).filter((name) => !savedRequestNames.includes(name));
    values.public.modelChannel.availableModels = resolveAvailableModels(values.public.modelChannel.availableModels, values.private.channels, newlyAddedRequestNames);
    try {
        values.public.modelChannel.userGroups = normalizeUserGroups(values.public.modelChannel.userGroups, availableUserGroupModels(values), savedGroups, values.private.channels);
    } catch (error) {
        message.error(error instanceof Error ? error.message : "用户分组配置错误");
        return null;
    }
    values.public.modelChannel.availableWorkflows = filterModels(values.public.modelChannel.availableWorkflows, collectChannelWorkflows(values.private.channels).map((item) => item.value));
    values.public.modelChannel.systemPrompt = values.public.modelChannel.systemPrompts.image || values.public.modelChannel.systemPrompts.text || "";
    return normalizeSettings(values);
}

function getJsonError(value: string) {
    try {
        JSON.parse(value);
        return "";
    } catch (error) {
        return error instanceof Error ? error.message : "JSON 格式不正确";
    }
}
