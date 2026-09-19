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
| `modelCosts` | object[] | 按渠道 ID 和模型分别配置算力点；后端选定渠道后预扣，失败时返还实际预扣额；未配置默认不扣除 |
| `defaultModel` | string | 默认模型，从 `availableModels` 中选择；为空或失效时优先选择文本模型 |
| `defaultImageModel` | string | 默认图片模型，从 `availableModels` 中选择；为空或失效时优先选择 `seedream`、`image`、`gpt-image` 模型 |
| `defaultVideoModel` | string | 默认视频模型，从 `availableModels` 中选择；为空或失效时优先选择 `seedance`、`video` 模型 |
| `defaultTextModel` | string | 默认文本模型，从 `availableModels` 中选择；为空或失效时优先选择非图片/视频模型 |
| `systemPrompt` | string | 系统提示词 |
| `allowCustomChannel` | boolean | 是否允许用户在配置弹窗中切换为本地直连渠道，默认允许 |

`modelCosts` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `channelId` | string | `private.channels[].id`，同名模型在不同渠道可分别定价 |
| `model` | string | 模型名称 |
| `credits` | number | 每次后端模型接口调用前预扣的算力点；图片多张生成按张数乘算 |

读取旧版仅含 `model` 和 `credits` 的价格时，系统将其复制到当时包含该模型的各渠道；已有渠道专属价格优先。未匹配渠道的旧价格保留在配置中，但不会参与扣费。后台按渠道（含停用渠道）列出全部模型，新模型未定价为 0 点。未指定渠道时，服务端可在可用渠道中选择；画布显示相应的预计点数范围。本地直连不扣点。流水 `extra.channelId` 记录实际调用渠道。

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
| `storage.autoSyncAllAssets` | boolean | 是否自动把新上传和生成的媒体同步到可用云存储，默认关闭；同步失败保留原始素材 |

### 已生成媒体的云端补传与本地副本

后台开启 `storage.autoSyncAllAssets` 只作用于后续新增媒体；已在 `generated-media/` 的历史对象不会因开关变化而自动补传。部署镜像包含维护命令 `/app/media-cloud`，可对历史对象分页补传，并在云端回读通过 SHA-256 校验后保持原 `server:<id>` 不变地切换对象索引。上传失败保持本地索引与文件；云端读取失败时已同步对象仍能回退本地副本。

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

### 生图历史摘要、缩略图与云端原图

生图工作台通过每页 40 条的轻量摘要读取历史；部署新镜像并完成数据库自动迁移后、恢复用户流量前，先分批回填旧日志摘要。分页接口不会在首屏临时读取大型旧载荷；未回填记录会暂不出现在列表中。命令默认只统计，显式 `-apply` 才写入 `summary_json`：

```bash
docker compose exec app /app/image-log-summaries -limit 10
docker compose exec app /app/image-log-summaries -apply -limit 10
```

按输出的 `nextCursor` 配合 `-after <ID>` 继续，直至 `inspected` 为 0。回填不清理旧 `payload_json`，也不读取或改写云端原图。

工作台列表通过 `/api/files/<id>/thumbnail` 读取最大 480 像素的 WebP 缩略图，原图预览、编辑和下载仍使用既有 `/content` 地址。缩略图默认缓存于 `/app/data/thumbnail-cache`，上限 512 MiB，可删除并自动重建；该目录不是原图备份。媒体响应的 `Server-Timing: storage-open` 可用于区分应用打开 WebDAV 与浏览器传输、解码耗时。

删除工作台记录会登记至少 30 天后的云媒体回收候选。`/app/media-gc` 只执行引用和云端校验审查；由于浏览器 IndexedDB 与离线项目无法被服务端完整观察，当前始终拒绝物理删除，不得将其替换为直接删除 WebDAV 目录的计划任务。

`channels` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `protocol` | string | 协议，支持 OpenAI、Gemini、Grok2API、xAI、MiniMax、APIMart、KIE、MiMo |
| `name` | string | 渠道名称 |
| `baseUrl` | string | 渠道接口地址 |
| `apiKey` | string | 渠道密钥 |
| `models` | string[] | 该渠道可用模型 |
| `weight` | number | 渠道权重；同一模型有多个可用渠道时按权重随机 |
| `enabled` | boolean | 是否启用 |
| `remark` | string | 备注 |

后端调用模型时，会从已启用、已配置 `baseUrl` 和 `apiKey`、且 `models` 包含目标模型的渠道中选择一个。

`agent.mcpServers` 每项可使用 `transport=streamable_http`（填写 `endpoint`、可选 `apiKey`）或 `transport=stdio`（填写 `command`、`args`、`env`、可选 `workingDirectory`）。`tools` 是允许 Agent 调用的工具白名单；`allowUsers` 为 `false` 时仅管理员可调用。系统 Skill 已迁移至 `agent_skills` 与 `agent_skill_files`，不再保存在此 JSON；旧 `private.agent.skills` 会在启动时一次性迁移。

`promptSync` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | 是否开启定时同步，默认开启 |
| `cron` | string | Cron 表达式，默认每天 0 点 |
