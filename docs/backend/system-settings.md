---
title: 系统配置数据结构
description: settings 表中 public 和 private 配置结构说明
---

# 系统配置数据结构

系统配置保存在 `settings` 表中，目前只使用两行：

| key | 说明 |
| --- | --- |
| `public` | 公开配置，前端可以读取 |
| `private` | 私有配置，只给后端和管理员使用 |

## public.value

```json
{
  "modelChannel": {
    "availableModels": ["gpt-5.5", "gpt-image-2"],
    "availableWorkflows": [],
    "modelCosts": [
      { "channelId": "channel-openai", "model": "gpt-5.5", "credits": 1 },
      { "channelId": "channel-openai", "model": "gpt-image-2", "credits": 10 }
    ],
    "defaultModel": "gpt-image-2",
    "defaultImageModel": "gpt-image-2",
    "defaultTextModel": "gpt-5.5",
    "systemPrompt": "",
    "allowCustomChannel": true
  },
  "auth": {
    "allowRegister": true,
    "linuxDo": {
      "enabled": false
    }
  },
  "agent": {
    "mcpServers": []
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `modelChannel` | object | 模型渠道公开配置组 |
| `auth` | object | 认证相关公开配置 |
| `agent.mcpServers` | object[] | 可向当前用户公开的 MCP 服务及工具白名单；不包含地址、密钥或 stdio 参数 |

`modelChannel` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `availableModels` | string[] | 系统可用模型；保存设置时会自动合并所有已启用私有渠道的模型 |
| `availableWorkflows` | string[] | 对普通用户开放的系统工作流标识；仅工作流渠道使用 |
| `modelCosts` | object[] | 按渠道 ID 和模型分别配置算力点；后端选定渠道后预扣，失败时返还实际预扣额；未配置默认不扣除 |
| `defaultModel` | string | 默认模型，从 `availableModels` 中选择；为空或失效时优先选择文本模型 |
| `defaultImageModel` | string | 默认图片模型，从 `availableModels` 中选择；为空或失效时优先选择渠道显式声明为 `image` 的模型，再兼容旧的 `seedream`、`image`、`gpt-image` 名称推导 |
| `defaultVideoModel` | string | 默认视频模型，从 `availableModels` 中选择；为空或失效时优先选择渠道显式声明为 `video` 的模型，再兼容旧的 `seedance`、`video` 名称推导 |
| `defaultTextModel` | string | 默认文本模型，从 `availableModels` 中选择；为空或失效时优先选择渠道显式声明为 `text` 的模型，再兼容旧的非图片/视频名称推导 |
| `systemPrompt` | string | 系统提示词 |
| `allowCustomChannel` | boolean | 是否允许用户在配置弹窗中切换为本地直连渠道，默认允许 |

`modelCosts` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `channelId` | string | `private.channels[].id`，同名模型在不同渠道可分别定价 |
| `model` | string | 模型名称 |
| `credits` | number | 每次后端模型接口调用前预扣的算力点；图片多张生成按张数乘算 |

读取旧版仅含 `model` 和 `credits` 的价格时，系统将其复制到当时包含该模型的各渠道；已有渠道专属价格优先。未匹配渠道的旧价格保留在配置中，但不会参与扣费。后台按渠道（含停用渠道）列出全部模型，新模型未定价为 0 点。未指定渠道时，服务端可在可用渠道中选择；画布显示相应的预计点数范围。本地直连不扣点。流水 `extra.channelId` 记录实际调用渠道。

### 模型能力声明

管理员可以在私有渠道配置中为模型声明通用能力，公开配置会按渠道和已开放模型返回同样的声明：

```json
{
  "modelCapabilities": {
    "acme-renderer-v7": ["image"],
    "multimodal-pro": ["image", "text"]
  }
}
```

值只能包含 `image`、`video`、`text`、`audio`。对某个模型存在声明时，前端完全按声明筛选；空数组表示该模型没有可用能力。删除该模型的声明后才回到旧版本的名称兼容推导，因此模型更名或自定义模型不再需要把 `image`、`video` 等关键词写进模型名。声明保存在 `private.channels[].modelCapabilities`，公开响应位于 `modelChannel.channels[].modelCapabilities`；两者都按所属渠道隔离，同名模型可以在不同渠道声明不同能力。

用户侧请求模式：

| 模式 | 说明 |
| --- | --- |
| 云端渠道 | 登录用户在后台允许云端渠道时默认使用；通过后端 `/api/v1/*` 代理接口，请求按模型名选择 `private.value.channels` 中的可用渠道，再按渠道和模型计费 |
| 本地直连 | 用户在配置页主动切换后使用；`allowCustomChannel` 关闭时不可选，浏览器本地配置 `baseUrl`、`apiKey` 和模型列表后直接请求模型接口 |

`auth` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `allowRegister` | boolean | 是否允许用户注册，默认允许；关闭后注册入口隐藏，注册接口拒绝新用户创建 |
| `linuxDo.enabled` | boolean | 是否开启 Linux.do 登录 |

### 图片输出格式能力

公开配置 `modelChannel.channels[].imageOutputCapabilities` 按模型声明可选输出格式，由服务端根据实际协议和模型推导，不需要新的数据库表或管理员填写第二份能力配置。例如：

```json
{
  "gpt-image-2": {
    "formats": ["png-transparent", "jpeg"],
    "defaultFormat": "png-transparent"
  }
}
```

`AiConfig.imageOutputFormat`、画布 Agent 配置、节点元数据和生成记录保存 `png-transparent` 或 `jpeg`；缺少字段或内部值为 `auto` 时不发送新增参数。新配置优先透明 PNG，若当前渠道不支持则按声明的默认格式回退。未指定渠道时，前端只使用全部候选渠道共同支持的格式；未知能力继续沿用渠道原有输出方式。

| 能力 | 请求行为 |
| --- | --- |
| OpenAI 协议的 GPT Image 模型 | 透明 PNG 对应 `output_format: "png"` 与 `background: "transparent"`；JPG 对应 `output_format: "jpeg"` |
| APIMart 的 `gpt-image-1-official`、`gpt-image-1.5-official`、`gpt-image-2-official`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` | 支持透明 PNG 和 JPG；透明 PNG 对应 `output_format: "png"` 与 `background: "transparent"`，JPG 对应 `output_format: "jpeg"` |
| APIMart 的其他已声明格式模型及 KIE 模型 | 保持已有 JPG 能力；KIE 使用其合法 `jpg` 枚举。APIMart 普通 `gpt-image-2`、`gpt-image-2-ext`、`gpt-image-2.5-ext` 不自动开放格式参数 |
| Grok2API/xAI 及其他未声明格式能力的模型 | 不新增格式或背景参数，保留原有协议转换 |
| RunningHub/ComfyUI | 仅使用工作流已明确绑定、启用且安全的输出格式字段；透明输出还需透明背景映射 |

Images 请求在根参数或编辑表单中传递格式，Responses 在 `image_generation` 工具中传递，图片 Chat 使用现有 `image_config`。普通文本请求不受影响。服务端根据实际渠道再次校验，回退信息写入调用日志；`X-Image-Output-Format` 表示生效的请求档位，不代表已验证图片包含透明 alpha。实际结果以媒体 MIME 和文件字节为准。

`response_format=b64_json` 只控制返回的传输编码，不能指定 PNG/JPG。媒体保存按实际内容识别 MIME 和扩展名；不会把 JPG 改名为 PNG，也不会做事后转换。透明 PNG 依赖上游真实能力，部署验收需检查 alpha 通道。[OpenAI 图片生成参数说明](https://developers.openai.com/api/docs/guides/image-generation)

APIMart 透明背景能力以其实际模型接口为准：[GPT Image 1/1.5 Official](https://docs.apimart.ai/en/api-reference/images/gpt-image-1/generation)、[GPT Image 2 Official](https://docs.apimart.ai/en/api-reference/images/gpt-image-2/official)、[GPT Image 2.5 Flare/Sunburst](https://docs.apimart.ai/en/api-reference/images/gpt-image-2.5/generation)。远程渠道使用服务端返回的能力信息；部署新代码后刷新公开配置，再打开工作台、画布节点或 Agent 的图像设置，在“质量”与“尺寸”之间选择输出格式。旧配置仍沿用渠道默认格式，选择透明 PNG 后才发送透明参数。

## private.value

```json
{
  "channels": [
    {
      "id": "channel-openai",
      "protocol": "openai",
      "name": "默认渠道",
      "baseUrl": "https://api.example.com",
      "apiKey": "sk-xxx",
      "models": ["gpt-5.5", "gpt-image-2"],
      "weight": 1,
      "enabled": true,
      "remark": ""
    }
  ],
  "promptSync": {
    "enabled": true,
    "cron": "0 0 * * *"
  },
  "agent": {
    "mcpServers": []
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `channels` | object[] | 模型渠道列表 |
| `promptSync` | object | GitHub 远程提示词定时同步配置 |
| `agent.mcpServers` | object[] | MCP 服务私有配置，包含传输和密钥；仅管理员接口可读 |
| `storage.autoSyncAllAssets` | boolean | 是否在本地生成媒体副本之后继续把新上传和生成媒体同步到可用云存储，默认关闭；同步失败保留本地稳定副本 |

### 已生成媒体的云端补传与本地副本

登录账号的渠道生成结果无论 `storage.autoSyncAllAssets` 是否开启，都会先写入 `generated-media/` 并获得稳定 `server:<id>`；该开关只控制之后是否继续同步到 WebDAV/S3。上云失败保持本地索引与文件，节点仍通过同一 `/api/files/:id/content` 地址读取。已在 `generated-media/` 的历史对象不会因开关变化而自动补传。部署镜像包含维护命令 `/app/media-cloud`，可对历史对象分页补传，并在云端回读通过 SHA-256 校验后保持原对象 ID 不变地切换对象索引。

先部署新镜像并确认应用启动、数据库自动迁移完成；核对数据库与媒体目录备份、云存储可达和目录挂载，再在部署容器内操作。维护命令默认不补传或删除媒体，但初次连接数据库沿用应用的 `AutoMigrate`，不能将其作为旧版本数据库上的绝对只读命令。若使用全局提供方，还要核对后台存储容量上限与实际 4 TB 配额相符（未配置时默认 9 GiB），避免容量巡检提前停用提供方：

```bash
docker compose exec app /app/media-cloud -mode sync -limit 10
docker compose exec app /app/media-cloud -mode sync -apply -limit 10
```

核对成功数和失败 ID；分批重复命令，直到只读扫描的 `inspected` 为 0。失败对象仍留本地；如前几项持续失败，可用输出的 `nextCursor` 配合 `-after <ID>` 定位后续批次，修复原因后重新从头扫描。需要让**今后的**新生成媒体也自动上云，必须在后台另行开启 `storage.autoSyncAllAssets` 并确保当前用户有可用提供方；批量补传命令的显式 `-apply` 不依赖该开关。

本地冗余副本的清理不是自动定时任务。云端索引建立满 30 天后、将媒体目录备份到独立位置且验证可恢复，再先只读查看候选；显式执行时会重新读取云端与本地、核对双方 SHA-256，任何异常都保留本地文件：

```bash
docker compose exec app /app/media-cloud -mode cleanup -limit 10
docker compose exec app /app/media-cloud -mode cleanup -apply -backup-confirmed -limit 10
```

`-min-age-days` 可调整保留期，但不得低于 7 天。此命令只清理验证后的冗余本地文件，不清理 `local-generated` 唯一副本、云端对象、任务或备份。不要直接对整个目录使用定时删除；如未来设置外部计划任务，也要保留备份验证和失败告警。提供方关闭、配置失效或远端内容不匹配时停止该对象清理。

### 历史临时媒体地址修复

`/app/canvas-media-repair` 用于修复画布节点及 Agent 会话中仅保存 `/api/proxy-image?url=...` 或 HTTP(S) 原链的媒体。默认 dry-run 会逐条下载、执行 SSRF/MIME/大小校验并输出画布 ID、节点/会话位置、原 URL、计划对象 ID、字节数和 SHA-256，不写数据库或媒体目录：

```bash
docker compose exec app /app/canvas-media-repair -limit 100
```

确认报告、数据库备份和应用写入已停止后才能应用：

```bash
docker compose stop app
docker compose run --rm --no-deps app /app/canvas-media-repair -apply -writes-stopped -limit 100
```

单条下载失败不会阻断其他条目；apply 模式只将该引用标记为 `broken` 并保留原 URL 与原因。命令不删除媒体、不执行 `VACUUM`，也不绕过私网和 metadata 地址防护。若超过一批，使用输出最后一项的用户和画布 ID传入 `-after-user`、`-after-canvas` 继续。

### 生图历史摘要与云端原图

生图工作台通过每页 40 条的轻量摘要读取历史；部署新镜像并完成数据库自动迁移后、恢复用户流量前，先分批回填旧日志摘要。分页接口不会在首屏临时读取大型旧载荷；未回填记录会暂不出现在列表中。命令默认只统计，显式 `-apply` 才写入 `summary_json`：

```bash
docker compose exec app /app/image-log-summaries -limit 10
docker compose exec app /app/image-log-summaries -apply -limit 10
```

按输出的 `nextCursor` 配合 `-after <ID>` 继续，直至 `inspected` 为 0。回填不清理旧 `payload_json`，也不读取或改写云端原图。

工作台分类与历史卡片、预览、编辑和下载均使用既有 `/content` 原图地址；列表分页并对未展示的卡片延迟加载，不再请求缩略图接口。媒体响应的 `Server-Timing: storage-open` 可用于区分应用打开 WebDAV 与浏览器传输、解码耗时。

删除工作台记录会登记至少 30 天后的云媒体回收候选。`/app/media-gc` 只执行引用和云端校验审查；由于浏览器 IndexedDB 与离线项目无法被服务端完整观察，当前始终拒绝物理删除，不得将其替换为直接删除 WebDAV 目录的计划任务。

`channels` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `protocol` | string | 协议，支持 OpenAI、Gemini、Grok2API、xAI、MiniMax、APIMart、KIE、MiMo、RunningHub、ComfyUI 等现有渠道 |
| `name` | string | 渠道名称 |
| `baseUrl` | string | 渠道接口地址 |
| `apiKey` | string | 渠道密钥 |
| `models` | string[] | 该渠道可用模型 |
| `modelCapabilities` | object | 可选的模型能力声明，键为模型名，值为 `image`、`video`、`text`、`audio` 数组；未声明时沿用旧名称推导 |
| `workflows` | object[] | RunningHub 或 ComfyUI 工作流条目，包含用途、启停状态、字段映射及工作流 JSON/拓扑 |
| `bridgeId` | string | ComfyUI 渠道绑定的 Bridge 设备 ID |
| `weight` | number | 渠道权重；同一模型有多个可用渠道时按权重随机 |
| `enabled` | boolean | 是否启用 |
| `remark` | string | 备注 |

后端调用模型时，会从已启用、已配置 `baseUrl` 和 `apiKey`、且 `models` 包含目标模型的渠道中选择一个。

工作流按 `workflow:<scope>:<channelId>:<kind>:<workflowId>` 标识；系统工作流可在同一 `modelCosts` 表按渠道单独定价。个人本地工作流不预扣系统算力点。Bridge 设备令牌仅在注册时返回明文，服务端保存哈希；不要把 ComfyUI 访问凭据放进浏览器配置或公开设置。

`agent.mcpServers` 每项可使用 `transport=streamable_http`（填写 `endpoint`、可选 `apiKey`）或 `transport=stdio`（填写 `command`、`args`、`env`、可选 `workingDirectory`）。`tools` 是允许 Agent 调用的工具白名单；`allowUsers` 为 `false` 时仅管理员可调用。系统 Skill 已迁移至 `agent_skills` 与 `agent_skill_files`，不再保存在此 JSON；旧 `private.agent.skills` 会在启动时一次性迁移。

`promptSync` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | 是否开启定时同步，默认开启 |
| `cron` | string | Cron 表达式，默认每天 0 点 |
