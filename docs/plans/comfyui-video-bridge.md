---
title: ComfyUI 视频工作流网关计划
description: 独立 ComfyUI 视频任务网关的实现计划，不接入当前无限画布功能
---

# ComfyUI 视频工作流网关计划

## 1. 目标

建设独立服务 `comfyui-bridge`，统一管理一个或多个 ComfyUI 实例，并只处理视频工作流。

本阶段不修改当前无限画布的模型渠道、画布、Agent、MCP、数据库或用户系统。网关先作为独立服务运行，完成后再决定是否接入无限画布。

网关需要完成：

1. 配置内网或外网 ComfyUI 实例。
2. 发现、导入、选择和启停视频工作流。
3. 将提示词、可选首帧/参考图、尺寸、帧数、FPS、Seed 写入已绑定的工作流节点。
4. 提交 ComfyUI 视频任务、显示进度、查询结果、下载视频。
5. 对调用方提供稳定 REST API。

## 2. 范围与边界

### 2.1 本阶段支持

- 文生视频工作流。
- 图生视频工作流的首帧或参考图输入。
- 内网 Tailscale 直连 ComfyUI。
- 外网 HTTPS 反向代理 ComfyUI。
- ComfyUI 任务提交、进度、失败、完成和视频下载。
- API workflow JSON 导入、校验和版本快照。

### 2.2 本阶段不支持

- ComfyUI 文生图、图片编辑、放大、分层和图片任务管理。
- 当前无限画布直接调用网关。
- 当前 Agent、MCP 或模型渠道直接调用网关。
- 自动猜测任意工作流的节点映射。
- 普通 UI workflow JSON 直接执行。
- 多租户、计费、额度或当前无限画布账号同步。
- 取消 ComfyUI 队列任务。

图片只作为视频工作流的首帧、角色图或参考图输入，不提供 ComfyUI 图片生成功能。

## 3. 部署与网络

### 3.1 首选：Tailscale 内网直连

网关部署在可以访问 Tailnet 的主机上，ComfyUI 使用 Tailscale IP、MagicDNS 主机名或 Tailscale HTTPS 地址。

前置条件：

- 网关主机已加入同一 Tailnet，或具备到 ComfyUI 节点的子网路由。
- 若网关运行在 Docker 内，容器必须可以通过宿主机路由访问 Tailscale 地址。
- Tailscale ACL 只允许网关节点访问 ComfyUI 节点的 API 端口。
- ComfyUI 不需要对公网开放端口。

### 3.2 备用：Nginx Proxy Manager 外网反代

当网关无法访问 Tailnet 时，可用 Nginx Proxy Manager 为 ComfyUI 提供 HTTPS 反代。

反代必须支持：

- HTTP API。
- WebSocket Upgrade。
- 长任务超时。
- 大文件上传和视频下载。

反代侧应限制来源 IP、请求体大小和并发。浏览器不直接请求 ComfyUI，仍由网关后端调用。

### 3.3 ComfyUI 实例鉴权

每个实例支持：

| 模式 | 请求方式 |
| --- | --- |
| `none` | 不附加鉴权头 |
| `bearer` | `Authorization: Bearer <token>` |
| `x-api-key` | `X-API-Key: <key>` |
| `basic` | HTTP Basic 用户名和密码 |

密钥只保存在网关私有配置或环境变量中，工作流查询和任务 API 不返回明文密钥。

## 4. 服务架构

`comfyui-bridge` 作为独立 Go 服务实现，使用 SQLite 保存配置和任务记录。

```text
调用方
  -> comfyui-bridge REST API
  -> ComfyUI 实例 HTTP / WebSocket API
  -> 本地视频缓存
  -> 调用方下载代理地址
```

### 4.1 存储

SQLite 保存：

- `instances`：ComfyUI 实例配置。
- `workflows`：视频工作流快照、绑定和启用状态。
- `jobs`：任务、Comfy `prompt_id`、状态、进度、输出文件。

本地磁盘保存：

- 导入的 workflow JSON 原文件。
- 下载的视频输出缓存。

输出文件默认保留 7 天，由定时任务清理。后续若接入对象存储，再增加转存策略。

### 4.2 网关鉴权

第一版为单管理员网关：

- 管理 API 和任务 API 都要求 `Authorization: Bearer <BRIDGE_ADMIN_TOKEN>`。
- `BRIDGE_ADMIN_TOKEN` 只通过环境变量配置。
- Tailscale ACL 或外部反代鉴权作为第二层保护。

不接入当前无限画布用户身份。

## 5. ComfyUI 实例配置

实例字段：

```json
{
  "id": "comfy-prod",
  "name": "视频 ComfyUI",
  "baseUrl": "http://comfy-host:8188",
  "networkMode": "tailscale",
  "authMode": "none",
  "authSecret": "",
  "workflowDirectory": "workflows",
  "enabled": true,
  "requestTimeoutSeconds": 900
}
```

字段规则：

- `baseUrl` 是 ComfyUI 服务根地址，不包含具体 API 路径。
- `networkMode` 仅用于安全校验与运维显示，支持 `tailscale`、`https`。
- `workflowDirectory` 只在实例开放用户工作流目录接口时使用。
- 保存实例前执行连接测试。
- 内网地址只允许管理员配置，任务请求不能传 `baseUrl`。

连接测试至少验证：

- 能访问 ComfyUI 节点信息接口。
- 能建立 WebSocket 连接。
- 请求地址不会重定向到其他 host。

## 6. 工作流发现与导入

### 6.1 来源

每个视频工作流有以下来源之一：

| 来源 | 说明 |
| --- | --- |
| `template` | 从 ComfyUI 模板接口同步 |
| `userdata` | 从管理员指定的用户工作流目录同步 |
| `import` | 管理员导入 API workflow JSON |

同步规则：

1. 管理员选择实例并执行“同步工作流”。
2. 网关尝试读取模板来源。
3. 若实例开放用户工作流目录，则读取 `workflowDirectory` 下的 JSON 文件。
4. 每个发现的文件执行 API workflow 校验。
5. 已存在且内容 hash 未变化的工作流不重复创建。
6. 已启用工作流不会因同步自动覆盖绑定；管理员明确刷新工作流版本时才更新快照。

### 6.2 API workflow 校验

可执行工作流必须满足：

- 顶层是节点对象映射。
- 每个节点包含 `class_type` 和 `inputs`。
- 管理员配置了视频输出节点。
- 管理员配置了正向提示词节点。

普通 UI workflow JSON 可以保留为导入草稿，但不能启用或运行。管理员需要在 ComfyUI 中导出 API workflow JSON 后重新导入。

### 6.3 工作流模型与显示名称

网关为每个启用视频工作流生成稳定运行 ID：

```text
comfyui-video/<workflow-id>
```

接口始终返回：

- `id`：稳定运行 ID。
- `name`：管理员可读名称。
- `instanceId`：所属 ComfyUI 实例。
- `enabled`：是否可运行。

后续接入无限画布时，界面只显示 `name`，运行时使用 `id`。

## 7. 节点绑定

不能自动假设所有 ComfyUI 工作流结构相同。管理员必须在启用前为每个工作流配置绑定。

### 7.1 必填绑定

| 名称 | 说明 |
| --- | --- |
| `prompt` | 正向提示词节点 ID 与 input 字段 |
| `videoOutput` | 最终视频输出节点 ID |

### 7.2 可选绑定

| 名称 | 说明 |
| --- | --- |
| `negativePrompt` | 负向提示词 |
| `width` / `height` | 视频尺寸 |
| `frames` | 帧数 |
| `fps` | 帧率 |
| `seed` | 随机种子 |
| `firstFrameImage` | 首帧图片文件名输入 |
| `referenceImages` | 多参考图文件名输入 |

绑定格式：

```json
{
  "prompt": { "nodeId": "6", "input": "text" },
  "width": { "nodeId": "3", "input": "width" },
  "height": { "nodeId": "3", "input": "height" },
  "frames": { "nodeId": "3", "input": "batch_size" },
  "firstFrameImage": { "nodeId": "12", "input": "image" },
  "videoOutput": { "nodeId": "28" }
}
```

输入字段未绑定时不传，不伪造该工作流支持对应能力。

## 8. 任务执行

### 8.1 提交视频

`POST /api/jobs`

请求：

```json
{
  "workflowId": "comfyui-video/wf_wan_i2v",
  "prompt": "雨夜城市中缓慢推进的电影镜头",
  "negativePrompt": "",
  "width": 1280,
  "height": 720,
  "frames": 81,
  "fps": 24,
  "seed": 12345,
  "firstFrame": "optional file upload",
  "referenceImages": []
}
```

执行步骤：

1. 校验网关调用凭据、工作流状态和必填绑定。
2. 将首帧/参考图上传到 ComfyUI `/upload/image`。
3. 复制 API workflow 快照，不修改已保存模板。
4. 根据绑定替换节点 input。
5. 生成唯一 `client_id` 并提交到 `/prompt`。
6. 保存网关任务和 Comfy `prompt_id`。
7. 返回网关任务 ID。

### 8.2 进度与完成

优先使用 ComfyUI WebSocket `/ws` 监听：

- 当前节点。
- 队列状态。
- 执行进度。
- 成功或失败事件。

WebSocket 断开或不可用时，轮询 `/history/{prompt_id}`。

完成后：

1. 从绑定的 `videoOutput` 中找到视频文件。
2. 通过 `/view` 下载输出文件。
3. 保存到网关本地缓存。
4. 更新任务为 `completed`。
5. 返回网关视频下载地址。

失败时保存 ComfyUI 节点错误摘要和原始错误预览，状态设为 `failed`。

### 8.3 查询 API

| 接口 | 作用 |
| --- | --- |
| `GET /api/jobs/:id` | 返回任务状态、进度、错误、输出信息 |
| `GET /api/jobs/:id/content` | 流式返回视频文件，支持 Range |
| `GET /api/jobs` | 按实例、工作流、状态查询任务 |

## 9. 管理 API

| 接口 | 作用 |
| --- | --- |
| `POST /api/instances` | 新增实例 |
| `PUT /api/instances/:id` | 更新实例 |
| `POST /api/instances/:id/test` | 测试连接 |
| `POST /api/instances/:id/workflows/sync` | 同步模板和用户目录工作流 |
| `POST /api/workflows/import` | 导入 API workflow JSON |
| `PUT /api/workflows/:id` | 更新名称、绑定、启用状态 |
| `GET /api/workflows` | 查询工作流列表 |
| `DELETE /api/workflows/:id` | 删除未使用工作流 |

删除已存在任务记录的工作流时，拒绝删除或要求先禁用，避免历史任务无法追溯。

## 10. 安全要求

- 不使用当前无限画布的普通媒体代理客户端访问 ComfyUI。
- 建立专用 ComfyUI HTTP 客户端。
- 请求 host、端口、协议仅从实例配置读取。
- 禁止任务 API 覆盖 `baseUrl`、鉴权信息、工作流 URL 或输出 URL。
- 禁止跨 host 重定向。
- 限制：
  - 上传文件大小。
  - 单实例并发任务数。
  - 单任务超时。
  - 单视频下载大小。
  - 本地缓存总容量。
- 日志不输出鉴权信息、完整 workflow 输入图片或完整敏感提示词。

## 11. 实现阶段

### 阶段 1：网关骨架

- 新建独立 Gitea 仓库 `comfyui-bridge`。
- Go 服务、SQLite、环境变量、健康检查、管理员 Token 鉴权。
- 实例 CRUD、Tailscale/HTTPS 鉴权配置、连接测试。

### 阶段 2：工作流管理

- 模板同步、用户目录同步、API JSON 导入。
- API workflow 校验。
- 节点绑定管理。
- 视频工作流列表和启用状态。

### 阶段 3：任务执行

- `/prompt` 提交。
- `/upload/image` 首帧和参考图上传。
- WebSocket 进度与 `/history` 回退。
- `/view` 下载、视频本地缓存和 Range 代理。

### 阶段 4：验证与运维

- Tailscale 内网实例验收。
- Nginx Proxy Manager HTTPS 反代实例验收。
- 日志、超时、缓存清理、并发限制。
- 输出 API 文档和部署文档。

## 12. 验收标准

### Tailscale

1. 网关容器可访问 Tailscale ComfyUI 地址。
2. 管理员可以测试实例连接。
3. 可以同步或导入一个 API 视频工作流。
4. 可以提交文生视频并下载完成视频。
5. 图生视频工作流可以接收首帧或参考图。

### Nginx Proxy Manager

1. HTTPS 反代支持 HTTP、WebSocket、上传和视频下载。
2. Bearer、X-API-Key 或 Basic 鉴权可正常运行。
3. 外网反代任务和 Tailscale 任务返回同样的网关任务结构。

### 异常

1. ComfyUI 节点执行失败时任务显示失败原因。
2. WebSocket 断开时任务通过历史轮询继续完成。
3. 工作流缺绑定时不能运行。
4. 非 API workflow JSON 不能启用。
5. 未配置 endpoint 或请求试图跳转到其他 host 时被拒绝。

## 13. 后续接入无限画布的条件

以下条件全部满足后，再开始设计无限画布接入：

1. 至少一个 Tailscale 视频工作流稳定运行。
2. 视频输出可稳定下载和 Range 播放。
3. 工作流绑定不依赖人工修改 JSON。
4. 任务、失败和重试接口稳定。
5. 网关的安全策略已经验证。

后续接入时，优先将启用工作流映射为视频模型，不直接把 ComfyUI 节点 JSON 暴露给画布用户。
