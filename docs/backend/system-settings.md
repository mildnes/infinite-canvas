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
| `modelCosts` | object[] | 按渠道 ID 和请求模型名分别配置算力点；图片按张、视频按秒、文本和音频按次预扣，失败或停止时返还实际预扣额；未配置默认不扣除 |
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
| `credits` | number | 支持两位小数的算力点单价；图片为每张、视频为每秒、文本和音频为每次，工作流为每次 |

读取旧版仅含 `model` 和 `credits` 的价格时，系统将其复制到当时包含该模型的各渠道；已有渠道专属价格优先。未匹配渠道的旧价格保留在配置中，但不会参与扣费。后台按渠道（含停用渠道）列出全部模型，新模型未定价为 0 点。未指定渠道时，服务端可在可用渠道中选择；画布显示相应的预计点数范围。本地直连不扣点。流水 `extra.channelId` 记录实际调用渠道。

视频预扣额为每秒单价乘以请求时长。按 `seconds`、`duration`、JSON 的 `parameters.durationSeconds` 顺序读取时长；智能时长 `-1` 按 15 秒计费。没有有效时长时尝试 `ceil((num_frames - 1) / frame_rate)`，仍无有效结果时按 1 秒。图片按请求张数乘算；文本和音频继续沿用请求次数语义。任务记录保存实际预扣额，失败或停止按同值退款。

启用视频按秒计费前应检查既有视频价格：例如原来 30 点／次的 5 秒任务，若保持 `credits=30`，会变为 30 点／秒；需要维持约 30 点／5 秒时应由管理员将单价调整为 6 点／秒。`MiniMax-H3` 的现有 30 点单价需在上线前按此口径确认；系统不会自动改价格。

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

渠道编辑器在自动状态下显示按协议和模型名推导的能力；自定义命名无法准确推导时，请手动勾选能力或批量应用。点击“恢复自动推导”会移除该模型的手动声明，批量清除也会恢复自动状态；手动取消全部勾选则保存为空数组。勾选和批量应用立即更新表单，保存渠道后生效。

### 图片质量能力

渠道还可以按模型声明 `imageQualityCapabilities`，用于把前端的 `low`、`medium`、`high`、`xhigh`、`max`、`auto` 档位映射为上游实际接受的值：

```json
{
  "imageQualityCapabilities": {
    "custom-renderer": {
      "values": ["low", "medium", "high", "auto"],
      "map": { "xhigh": "high", "max": "high" },
      "defaultValue": "high"
    }
  }
}
```

在后台“模型渠道”设置中，非工作流渠道会为每个已选模型提供可展开的图片质量编辑器。可启用或关闭该模型的声明；关闭会删除该模型规则，使请求恢复原样透传。允许值可用标签录入上游支持的字符串，再为 `low`、`medium`、`high`、`xhigh`、`max`、`auto` 六档选择映射，并选择默认回退值；映射目标和默认值只能从允许值中选择。删除允许值会立即清理引用该值的映射和默认值，清空允许值（`values: []`）表示不发送 `quality`。保存并重新打开渠道后配置仍保留。也可继续通过后台私有配置 JSON 编辑器维护声明；配置按渠道和模型隔离，同名模型在不同渠道互不影响。公开配置返回 `modelChannel.channels[].imageQualityCapabilities`。

`values` 是上游允许的原始值，`map` 是 UI 档位到原始值的显式映射，`defaultValue` 是无法匹配时的回退值。映射和默认值必须在 `values` 中；无法匹配且没有合法默认值时省略 `quality` 并提示。当前没有自动识别 Rolldek 等域名的规则，未声明渠道继续原样透传。登录请求由服务端按实际渠道校验，未登录本地直连从本地渠道声明解析；仅处理已带 `quality` 的图片请求，不主动注入参数。改写通过 `X-Image-Quality` 与 `X-Image-Quality-Notice` 响应头及界面提示可追踪，移除参数时只有 Notice；本地参数转译结果还返回 `imageQuality` 和 `imageQualityNotice`。`codexCli` 兼容模式只负责提示词保护和并发策略，不再静默删除 `quality`。

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

公开配置 `modelChannel.channels[].imageOutputCapabilities` 按渠道和模型返回可选输出格式。服务端优先使用渠道私有配置 `private.channels[].imageOutputCapabilities` 的显式声明；未声明时才匹配仓库共享规则 `shared/image-output-capability-rules.json`。本地直连也先读该渠道的显式声明，再匹配同一份共享规则，不再各自维护模型启发式列表。例如：

```json
{
  "gpt-image-2": {
    "formats": ["png-transparent", "jpeg"]
  },
  "custom-image-model": {
    "formats": []
  }
}
```

`formats` 可包含 `png-transparent`、`png`（不透明）、`jpeg`，其中声明 `png-transparent` 的模型会自动获得 `png`（不透明）能力；空数组 `[]` 是显式声明，表示该模型不开放这些输出格式，不等同于未声明，也不回退到共享规则。`defaultFormat` 是可选字段；仅当其值也在 `formats` 中时有效。缺少或无效时保存为空，不自动制造支持格式。请求所选格式不受支持时，仅在存在有效默认值时切换到该值；否则保留 `auto`。`AiConfig.imageOutputFormat`、画布 Agent 配置、节点元数据和生成记录保存 `png-transparent`、`png`（不透明）、`jpeg` 或 `auto`（渠道默认，图像设置面板可随时切回）；旧配置缺少格式或值为 `auto` 时不主动注入格式、背景参数。未指定渠道时，前端只提供全部候选渠道共同支持的格式。

后台“模型渠道”设置为非工作流渠道的每个模型提供可展开的“图片输出格式声明”编辑器，可启用或关闭声明、选择透明 PNG/PNG（不透明）/JPEG，并从已选格式中选择可选默认值。关闭会删除该模型的声明键；JSON 手写的声明仍会被可视化保存保留，包括 `formats: []`。保存时按模型保留、过滤未知格式并去重；无效或未包含在格式列表内的默认值会被清除。声明按渠道和模型隔离，同名模型在不同渠道互不影响。

共享规则的唯一维护源是 `shared/image-output-capability-rules.json`。前端 `bun run dev` 和 `bun run build` 会先通过 `sync:shared` 将其复制到 `web/src/lib/image-output-capability-rules.json`，应用和逻辑测试都读取这个应用内副本，避免 Turbopack 越根导入。副本由 Git 忽略，不应手工修改或提交；单独运行前端逻辑测试前，先执行 `cd web && bun run sync:shared`。修改规则后重新同步，Go 仍直接嵌入原始共享文件。

| 能力 | 请求行为 |
| --- | --- |
| OpenAI 协议的 GPT Image 模型 | 透明 PNG 对应 `output_format: "png"` 与 `background: "transparent"`；JPG 对应 `output_format: "jpeg"` |
| APIMart 的 `gpt-image-1-official`、`gpt-image-1.5-official`、`gpt-image-2-official`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` | 支持透明 PNG 和 JPG；透明 PNG 对应 `output_format: "png"` 与 `background: "transparent"`，JPG 对应 `output_format: "jpeg"` |
| APIMart 自定义别名或其他模型的显式声明 | 按声明发送格式；例如普通 `gpt-image-2` 可手动声明透明 PNG，未声明时保持原有删除格式参数的规则。声明不改变质量、尺寸或分辨率转换 |
| APIMart 既有 JPG 模型及 KIE 模型 | 保持已有 JPG 能力；KIE 使用其合法 `jpg` 枚举，透明 PNG 的线格式仍只发送 `png`。APIMart 的 `*-ext` 模型未声明时不自动开放格式参数 |
| Grok2API/xAI 及其他未声明格式能力的模型 | 不新增格式或背景参数，保留原有协议转换 |
| RunningHub/ComfyUI | 仅使用工作流已明确绑定、启用且安全的输出格式字段；透明输出还需透明背景映射 |

Images 请求在根参数或编辑表单中传递格式，Responses 在 `image_generation` 工具中传递，图片 Chat 使用现有 `image_config`。普通文本请求不受影响。服务端根据实际渠道再次校验。显式声明优先于共享规则；远程模型未声明时不匹配前端猜测规则，而是保留原请求并提示 `undeclared`。图片响应可能带 `X-Image-Output-Notice`：`undeclared`（模型未声明能力）、`fallback-default`（所选格式无法使用，按合法默认格式回退；没有合法默认值时保留 `auto`）、`upstream-no-alpha`（透明 PNG 上游结果没有透明通道）或 `upstream-alpha-unverified`（无法验证透明通道）。画布异步任务的 JSON 会返回 `imageOutputNotice`、`imageOutputNoticeCode`，前端据此提示。`X-Image-Output-Format` 表示请求生效档位，不代表已验证图片包含透明 alpha；Notice 只报告能力或结果校验情况。

本地直连配置保存并恢复 `localChannels[].imageOutputCapabilities`。需要后端参数转译的渠道会传递模型列表和能力声明，不传递渠道 API Key；转译结果返回 `imageOutputFormat`、`imageOutputNotice`、`imageOutputNoticeCode`。浏览器直连上游的产物不经过这条后端结果校验，应使用下面的探针检查真实透明像素。账号或页面切换后，旧转译请求的提示不会写入当前页面。

`response_format=b64_json` 只控制返回的传输编码，不能指定 PNG/JPG。媒体保存按实际内容识别 MIME 和扩展名；不会把 JPG 改名为 PNG，也不会做事后转换，透明校验也不修补或转换原媒体。透明 PNG 依赖上游真实能力，部署验收需检查 alpha 通道。[OpenAI 图片生成参数说明](https://developers.openai.com/api/docs/guides/image-generation)

透明 PNG 的专用结果校验必须先收到完整响应并检查图片字节，再发送响应头。因此这条透明结果校验路径会缓冲上游响应；图片 SSE 也会以完整汇总结果交付，而不是渐进流式交付。普通文本 SSE 行为不变。该限制仅适用于选择透明 PNG 并经过结果验证的响应。

仓库提供 [透明 PNG 探针](../../scripts/image-transparency-probe.py)，需要 Python 3 与 Pillow。对已有产物执行下面的命令不会生成图片；通过条件是 PNG 中至少一个像素的 `alpha=0`，RGB 棋盘格会失败，并返回字节数、SHA-256 和透明像素比例：

```bash
python3 scripts/image-transparency-probe.py --file /path/to/result.png
```

要发起真实生成，先通过运行环境安全设置 `IMAGE_PROBE_API_KEY`，再传入准确的 Images 生成端点和模型。以下命令会提交一次生成请求；使用应用代理时环境变量应是账号令牌，并增加 `--channel-id` 指定实际渠道。脚本不打印凭据、不覆盖已有 `--out` 文件；它要求接口返回完成图片，原始异步渠道需先通过应用代理完成轮询或用 `--file` 检查已下载结果。

```bash
python3 scripts/image-transparency-probe.py --endpoint https://api.example/v1/images/generations --model MODEL --out /path/to/new-result.png
```

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

登录账号的渠道生成结果无论 `storage.autoSyncAllAssets` 是否开启，都会先写入 `generated-media/` 并获得稳定 `server:<id>`。开启自动同步后，上传失败会记录原因和下次重试时间，固定目标并通过租约防止重复执行；重启后接管过期任务。只有完整云端回读通过字节数和 SHA-256 校验才确认同步成功，失败保留本地副本和短链接。切换开关不会自动补传全部历史对象。

部署镜像包含 `/app/media-verify` 和 `/app/media-cloud`。两者默认使用已有数据库的只读连接，不执行 AutoMigrate；先部署应用完成新字段初始化，再巡检。`media-verify` 支持云端回填、本地补传和同 SHA-256 兄弟恢复；`media-cloud -mode sync` 同样覆盖已登记云端但文件缺失的对象，写入新增 `-writes-stopped` 要求，必须备份并停写后执行。分页用 `nextCursor` 和 `-after` 继续，不能反复从头扫描等待健康对象消失。

命令、同步状态及维护流程见 [媒体巡检与同步维护](media-sync-recovery.md)。原有本地副本清理继续要求至少七天保留期（默认三十天）、独立备份确认及双方完整校验，不建立自动删除任务。全局 provider 仍需核对后台容量上限与实际配额，避免容量巡检提前停用存储。

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

### 画布 originalUrl 内联副本抽离

先部署节点保存清洗，再迁移存量，防止旧浏览器状态将 Base64 写回。`original-url` 模式只处理节点 `metadata.originalUrl` 以 `data:` 或 `blob:` 开头、且已有 `server:<objectId>` 的副本，不执行远程图床下载、上传、媒体删除或 `VACUUM`。现有默认 `media` 模式仍用于上节的临时 URL 修复。

先在测试数据库验证；生产预览命令：

```bash
docker compose exec app /app/canvas-media-repair -mode original-url -limit 100
```

SQLite dry-run 使用只读连接，不创建表或自动迁移。每条报告包含 `canvasId`、`nodeId`、`before`（最多 64 字节前缀）、`beforeBytes`、`after`、`objectId`、`bytes`、`sha256`、状态和失败原因，不输出整段 Base64。替换前确认对象 ID 匹配且未删除，并通过现有存储读取链路校验完整字节数与 SHA-256。同账号对象保持原规则；跨账号对象还必须将节点 `originalUrl` 的 Base64 解码，与对象记录的字节数及 SHA-256 完全匹配后才允许替换，无需额外开关。跨账号 Blob、无效 Base64 或内容不等价时保留原值并报告失败。同一画布的重复对象只读取一次，但每个节点的 Base64 均独立校验；没有持久化键或对象不可读时保留原值，单条失败不影响其他可验证节点。

确认 dry-run 报告、停止应用写入并完成数据库独立备份后执行：

```bash
docker compose stop app
docker compose run --rm --no-deps --pull never app /app/canvas-media-repair -mode original-url -apply -writes-stopped -limit 100
docker compose start app
```

必须使用包含本轮修复的已部署镜像，不拉取上游 `latest`。只将已验证节点的 `originalUrl` 写为 `/api/files/<id>/content`，同时更新项目时间；`content`、`storageKey`、连线、会话和存储对象保持原样，写入前检查项目快照，拒绝覆盖已变更或已删除画布。汇总中的 `afterUser`、`afterCanvas` 用于下一批的 `-after-user`、`-after-canvas`；任何条目或画布失败时退出码为 1，仍输出其他成功条目的报告。处理完全部分页后从头 dry-run，应无候选。

部署验收需扫描节点 `originalUrl`，核对 `project_data` 总字节和最大画布字节，检查刷新、重试、局部编辑及报告中的短链接均可读取真实媒体。JSON 逻辑体积下降不等于 SQLite 文件立即变小；数据库压缩和备份清理另行安排。

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
| `imageQualityCapabilities` | object | 可选的图片质量能力声明，键为模型名，值包含上游允许的 `values`、UI 档位到上游值的 `map` 及回退 `defaultValue` |
| `imageOutputCapabilities` | object | 可选的图片输出格式声明，键为模型名，值包含 `formats` 与可选 `defaultFormat`；`formats: []` 显式禁用格式能力 |
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
