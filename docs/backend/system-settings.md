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
