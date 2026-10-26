---
title: 画布数据结构
description: 画布本地存储、节点结构、媒体文件与清理机制
---

# 画布数据结构

本文档说明当前画布在前端本地保存的数据结构、图片文件的存储和清理方式，以及后续接入后端存储时建议保持的兼容边界。

## 当前存储位置

当前画布项目主要保存在浏览器本地：

- 画布项目 JSON：`localForage`，数据库名 `infinite-canvas`，storeName `app_state`；正文键为 `canvas_project:<owner>:<id>`，账号索引键为 `canvas_meta:<owner>`，冲突草稿正文键为 `canvas_conflict:<owner>:<id>`。
- 我的素材 JSON：`localForage`，数据库名 `infinite-canvas`，storeName `app_state`，key 为 `infinite-canvas:asset_store`。
- 图片 Blob：单独存到 `localForage` 实例，数据库名 `infinite-canvas`，storeName `image_files`。
- 视频等媒体 Blob：单独存到 `localForage` 实例，数据库名 `infinite-canvas`，storeName `media_files`。

画布 JSON 不直接长期保存大体积 base64 图片或视频。图片节点、视频节点、助手图片和素材媒体只保存展示 URL、`storageKey` 和元信息，真实 Blob 通过 `storageKey` 读取。

## 复制与保存安全不变量

- **复制不继承任务归属。** 单节点副本清除批次根／子图关系和图片、视频、音频任务及结果 ID，有内容时状态为 `success`，否则为 `idle`；稳定媒体 URL 与 `storageKey` 可共享。只有同时选中根与全部子图时才保留批次结构，根／子图／主图 ID 全部映射到新副本，连线也只连接副本。原节点不变，原批次的级联删除规则不变。
- **后台同步不得提交请求前的旧快照。** 列表返回后以最新 store 为合并基准；补传或冲突详情请求期间的新编辑、新建和删除也要保留。若远端版本比本机编辑所基于的版本更新，继续由现有 `recordSaveError` 保存本机 `conflictDrafts`，使用远端完整副本作为当前版本，不修改 CAS／409 契约。列表晚于成功保存回包时不得回滚到旧标题。任何等待后 owner／epoch 不匹配则放弃。
- **共享账号索引保留其他窗口新增的画板。** 写入前读取最新 `canvas_meta:<owner>`；只把本实例曾见过、此次明确省略的 ID 视为删除。支持 Web Locks 的浏览器按账号串行执行读改写；画板正文成功后才提交索引。
- **删除记录不能被陈旧索引抹掉。** 索引使用可选 `deletedProjectIds`，并保存小型独立 `canvas_deleted:<owner>:<id>` 删除记录。旧 `format: 1` 索引仍可读取；删除记录不保存节点或媒体，后续合并与旧整包导入都不得恢复这些 ID。恢复已删除画板应另存为新 ID。
- **没有 Web Locks 时仍可找回正文。** 水合会枚举当前 owner 的正文键，补足并发覆盖索引遗漏的 ID，再排除独立删除记录；仅枚举键名，不读取其他账号的正文。陈旧写入即使最后提交，也不能使已落盘的新画板从刷新后的列表中消失，或使已删除画板复活。
- **摘要与账号边界保持。** `hydrated: false` 不写画板正文、不上报；只写有编辑权的完整副本，原有账号切换、单写者锁、远端删除保护和保存队列保留。

确定性回归入口：`web/src/app/(user)/canvas/utils/canvas-node-copy.test.mjs` 与 `web/src/lib/canvas-data-loss-regressions.test.mjs`。测试实际执行页面复制／粘贴／删除回调，以及真实 Zustand store 和分键存储；受控 Promise 覆盖同步交错，独立存储实例覆盖共享索引。设置 `CANVAS_COPY_BASELINE`、`CANVAS_STORE_BASELINE`、`CANVAS_STORAGE_BASELINE` 可从指定 Git 提交加载对应旧实现，复跑红灯证据。

## 画布项目结构

每个画布项目是一个 `CanvasProject`：

```ts
type CanvasProject = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodes: CanvasNodeData[];
  connections: CanvasConnection[];
  chatSessions: CanvasAssistantSession[];
  activeChatId: string | null;
  backgroundMode: "lines" | "dots" | "blank";
  viewport: { x: number; y: number; k: number };
};
```

字段说明：

- `id`：画布项目 ID，当前前端生成。
- `title`：画布名称。
- `createdAt` / `updatedAt`：ISO 字符串。
- `nodes`：画布节点列表。
- `connections`：节点连线列表。
- `chatSessions`：右侧画布助手会话。
- `activeChatId`：当前选中的助手会话 ID。
- `backgroundMode`：画布背景模式。
- `viewport`：视口变换，`x/y` 是屏幕平移，`k` 是缩放比例。

## 节点结构

每个节点是一个 `CanvasNodeData`：

```ts
type CanvasNodeData = {
  id: string;
  type: "image" | "text" | "config" | "video";
  title: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  metadata?: CanvasNodeMetadata;
};
```

通用字段：

- `id`：节点 ID。
- `type`：节点类型，当前有图片、文本、生成配置、视频四类。
- `title`：节点标题。
- `position`：画布世界坐标，不是屏幕坐标。
- `width` / `height`：画布世界坐标下的节点尺寸。
- `metadata`：节点内容和业务状态。

`metadata` 当前常用字段：

```ts
type CanvasNodeMetadata = {
  content?: string;
  prompt?: string;
  status?: "idle" | "success" | "loading" | "error";
  errorDetails?: string;
  fontSize?: number;
  generationMode?: "text" | "image" | "video";
  model?: string;
  size?: string;
  count?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  freeResize?: boolean;
  isBatchRoot?: boolean;
  batchRootId?: string;
  batchChildIds?: string[];
  primaryImageId?: string;
  imageBatchExpanded?: boolean;
  inputOrder?: string[];
  storageKey?: string;
  mimeType?: string;
  bytes?: number;
};
```

不同节点的使用方式：

- 图片节点：`content` 是当前可展示的图片 URL，通常是 `blob:` URL；`storageKey` 指向本地图片 Blob；`naturalWidth/naturalHeight/bytes/mimeType` 保存原图信息。
- 视频节点：`content` 是当前可播放的视频 URL，通常是 `blob:` URL；`storageKey` 指向本地视频 Blob；`bytes/mimeType` 保存文件信息。
- 文本节点：`content` 保存文本内容；`fontSize` 保存字体大小；`prompt/status/errorDetails` 保存生成状态。
- 生成配置节点：`generationMode/model/size/count/inputOrder` 保存生成配置；`generationMode` 可选择文本、图片或视频；上游输入通过 `connections` 计算。
- 图片组节点：根节点用 `isBatchRoot/batchChildIds/primaryImageId/imageBatchExpanded` 记录批量生成结果；子图节点用 `batchRootId` 指回根节点。

## 连线结构

每条连线是一个 `CanvasConnection`：

```ts
type CanvasConnection = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};
```

连线只保存节点 ID，不保存端口坐标。渲染时根据节点位置和尺寸计算路径。

删除节点时会同步删除以该节点为起点或终点的连线。删除图片组根节点时，会把对应子节点一起删除。

## 助手会话结构

助手会话保存在画布项目内：

```ts
type CanvasAssistantSession = {
  id: string;
  title: string;
  messages: CanvasAssistantMessage[];
  createdAt: string;
  updatedAt: string;
};
```

消息结构：

```ts
type CanvasAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  mode: "ask" | "image";
  text: string;
  isLoading?: boolean;
  references?: CanvasAssistantReference[];
  images?: CanvasAssistantImage[];
};
```

图片引用和助手生成图片也遵循同一套图片存储规则：

- `dataUrl` 字段当前可能是 `blob:` URL，也可能是旧数据中的 `data:image/...`。
- `storageKey` 存在时，以 `storageKey` 为准读取图片 Blob。
- 发送到 AI 接口前，如果接口需要 base64，会通过 `imageToDataUrl` 临时把 Blob URL 转成 data URL。

## 图片写入流程

所有新增图片应通过 `uploadImage(input)` 写入：

1. 传入 `Blob` 或 data URL。
2. 内部转成 `Blob`。
3. 生成 `storageKey`，格式为 `image:<id>`。
4. 把 Blob 写入 `image_files`。
5. 创建 `blob:` URL，并缓存在内存 `objectUrls`。
6. 读取图片宽高，返回：

```ts
type UploadedImage = {
  url: string;
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
};
```

图片节点会通过 `imageMetadata(image)` 写入：

```ts
{
  content: image.url,
  storageKey: image.storageKey,
  status: "success",
  naturalWidth: image.width,
  naturalHeight: image.height,
  bytes: image.bytes,
  mimeType: image.mimeType
}
```

因此，`content` 只适合当前浏览器会话展示，不能作为长期文件标识；长期标识是 `storageKey`。

## 图片读取和旧数据迁移

打开画布时会执行图片补水：

- 如果图片节点有 `storageKey`，通过 `resolveImageUrl(storageKey, fallback)` 读取 Blob 并生成新的 `blob:` URL。
- 如果图片节点没有 `storageKey`，但 `content` 是旧的 `data:image/...`，会调用 `uploadImage(content)` 迁移到 `image_files`，并补上 `storageKey`。
- 助手消息里的引用图和生成图也会执行同类逻辑。

我的素材读取时也会做迁移：

- 有 `storageKey`：恢复 `coverUrl` 和 `data.dataUrl` 的可展示 URL。
- 无 `storageKey` 且保存了 base64：写入 `image_files`，然后更新素材里的 `storageKey`。

## 图片移除和清理

图片不是在删除节点时立即按节点逐张删除，而是做引用清理：

1. 删除节点、清空画布、删除画布、删除素材、删除助手会话时，会触发 `cleanupImages`。
2. `cleanupImages` 会收集当前仍被画布项目、素材和额外传入数据引用的所有 `storageKey`。
3. `cleanupUnusedImages` 遍历 `image_files` 中的全部图片。
4. 不在引用集合里的图片会被删除。
5. 删除时会同时 `URL.revokeObjectURL`，并从内存缓存 `objectUrls` 移除。

这套方式可以避免同一张图片被画布、素材或助手同时引用时误删。
