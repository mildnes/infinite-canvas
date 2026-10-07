# 画布图片预览副本

画布图片节点、引用标签和节点侧栏优先读取轻量预览；透明图片使用保留 alpha 的 PNG，不透明图片使用 JPEG。全屏先展示预览，再加载原图。预览失败时回退原图，下载、生成参考图、编辑、Agent、导出和上云仍使用原始媒体。生图工作台不使用这条预览链路。

## 存储与生成

预览最长边 1024。客户端与服务端先缩放，再按原比例降采样至最长边 64，检查是否有 `alpha < 250`：有则生成 `previews/<objectId>.png` 并保留透明背景；否则生成 `previews/<objectId>.jpg`，沿用 JPEG quality 80／0.8 与近不透明像素的白底合成。判断基于解码像素，覆盖 PNG、WebP、GIF 等格式，不能按 MIME 推断透明性。服务端 PNG 使用标准库 BestCompression，缩放目标为透明的 NRGBA。

任一扩展名的预览存在时，首次有效写入保留，跨格式不能覆盖。发布沿用原子硬链接；同对象的 `.id.lock` 文件使用 Linux/macOS 文件锁串行化服务端及 CLI 写入，锁文件为空且不删除，避免等待者持有不同锁 inode。移走旧预览后可以重新生成，锁文件无需清除。没有新增依赖、数据库字段或云端预览文件，原图字节不改变。

浏览器上传图片、生成媒体持久化和登录后的 WebDAV 直传注册时，使用已持有的 Blob 在后台生成预览，优先 OffscreenCanvas，兼容普通 Canvas；不会为了制作预览额外下载原图。浏览器最多两个编码任务，失败不影响媒体成功状态。提交绑定捕获的账号 token，账号变化后不提交旧任务；预览操作不回写画布节点。

服务端图片落盘、上传与直传注册完成后，延迟十秒排队兜底；未就绪的预览请求也可触发生成。队列最多 256 个对象、两项并发，同对象任务合并，失败冷却一分钟。读取优先使用本地原图，否则沿用已有对象读取链路和 SSRF 防护；对有字节数、SHA-256 的记录核对完整源文件。

服务端支持 JPEG、PNG、GIF、BMP、TIFF、WebP 解码，读取上限 128 MiB、解码上限 64 Mi 像素；不支持的格式或超限图片回退原图。浏览器支持的格式可先提交预览。视频、音频和全景查看器不改读取方式。极大图片的额外解码内存仍需部署端核对，不能以预览尺寸代替原图解码成本。

`previews/` 是可再生显示缓存，不能算作原图本地副本、恢复来源或完整备份。现有巡检、回填与清理根据对象原始扩展名定位文件，不扫描该子目录。此次不删除任何缓存、原图或备份。

## 预览缺失后浏览器补齐

画布主图和全屏图片在预览失败、原图成功加载后，使用图片元素的实际 `naturalWidth/naturalHeight` 请求最长边不超过 1024 的 `createImageBitmap`，再按上述像素检测选择 PNG/JPEG 并提交预览 PUT。补齐只接受 `^server:[A-Za-z0-9_-]+$` 存储键及预览失败时捕获的登录 token；没有原图成功加载事件时不执行。已有预览的普通图不会触发补齐，引用标签和侧栏未接入这一步。

原图读取使用 `cache: "only-if-cached"`、`mode: "same-origin"`，只读取已有 HTTP 缓存；缓存未命中直接跳过，不补发网络下载。这两个选项遵循 [Fetch 缓存模式规范](https://fetch.spec.whatwg.org/#concept-request-cache-mode)。跨源或已被浏览器逐出的缓存可能无法补齐，原图仍按原有路径显示。

每个 token＋对象在当前页面会话只尝试一次，失败也不自动重试；整个缓存读取、缩放、上传流程最多两个同时运行，待处理队列最多 64 项。读取、解码及提交前检查账号；队列中的旧账号任务丢弃。缓存、解码和 PUT 失败均静默，不改变节点内容、原图字节或媒体状态。补齐的缩放解码失败或浏览器不支持 `createImageBitmap` 时，不退回 DOM 再解码巨图；原有上传预览的兼容路径保留。

此流程复用所有者鉴权及首次有效写入胜出的 PUT，不修改服务端解码上限，也不追加服务端原图下载。浏览器内部解码峰值仍取决于实现，450MP 样本需在部署端实测；不能将缩放输出尺寸当作浏览器内存峰值的保证。刷新后画板主图可命中补齐的预览，全屏仍按原有两段式行为读取原图。

## 接口

| 接口 | 行为 |
|---|---|
| `GET/HEAD /api/files/:id/preview` | 对存在且未删除的图片，缓存就绪返回 200，按实际文件嗅探 `image/png` 或 `image/jpeg`；内容 SHA-256 强 ETag，`public, max-age=300, must-revalidate`，支持 304 和 Range。缺失返回真正的 404、`no-store`，异步生成不阻塞响应。 |
| `PUT /api/v1/files/:id/preview` | Bearer 登录鉴权，只允许对象所有者提交完整 JPEG（最多 2 MiB）或 PNG（最多 4 MiB），宽高各不超过 1024。按内容 DecodeConfig 及完整解码校验，不信任请求 Content-Type；前端请求头使用 Blob 实际 MIME。重复有效提交不覆盖，返回标准成功信封。无权 403、对象不存在 404、格式/体积错误 400。 |

显示 URL 使用 `/api/files/:id/preview?v=2`，绕过此前已进入浏览器的一年 immutable 缓存；仅改变派生显示地址，节点原始引用不变。新 URL 最多五分钟后重新校验，主动刷新时也可进行条件请求；重生成后的内容哈希变化会返回新内容。修改服务端缓存头不能单独使已缓存的旧 URL 立即失效。

读取权限沿用现有公开 `/content` 路由，而非新增私有媒体权限。匿名对象依赖服务端兜底；未注册为对象 ID 的 `server:webdav:` 引用保持原读取。前端仅在展示位置派生 URL，不把 `/preview` 写进 `content`、Agent 原图引用或画板 JSON。

## 历史预览补齐

使用包含 `/app/media-previews` 的已核对新镜像和持久化媒体挂载。先在测试环境跑默认 dry-run：

```bash
docker compose exec app /app/media-previews -limit 100 -workers 2
docker compose exec app /app/media-previews -object <OBJECT_ID>
```

dry-run 只读数据库、检查两种扩展名的现有缓存，不下载原图、不创建目录、不更新数据。报告每个对象的 `candidate/existing/skipped` 和 `format`（`jpeg/png/unknown`），汇总已知格式数量。按候选每张 300 KiB 给出初步容量规划估计，同时 `maxPreviewBytes` 按候选每张 4 MiB 给出接收上限；不能把 JPEG 估计当作透明 PNG 的实际大小。未解码的候选格式为 unknown；`estimatedSeconds` 为 null，实际体积和耗时需测量。

先显式生成一个小批次并检查实际 `durationMs` 和 `previewBytes`，再按实际吞吐规划其余批次：

```bash
docker compose exec app /app/media-previews -apply -limit 10 -workers 2
docker compose exec app /app/media-previews -apply -limit 100 -workers 2 -after <NEXT_CURSOR>
```

两种模式都使用只读数据库连接，apply 仅创建缓存。按汇总 `nextCursor` 续跑，直到 `scanned=0`。单对象失败会继续处理其他对象并返回退出码 1；失败对象需用 `-object` 单独重试或重跑本批。中断时游标只推进到连续完成的行，重跑已有缓存会跳过。此工具不执行迁移、媒体删除或 VACUUM，也不调用收费 AI 接口。

### 已确认白底空白预览的定点修复

部署端报告全库 2560 个图片对象中有 290 个带 alpha，已确认四个白字/白 logo 空白预览。此为部署端证据，本机未重新测量。部署新代码后，仅核对并人工移走下列对象在 `generated-media/previews/` 内的旧 `.jpg`（建议保留到独立缓存备份目录）；不要移动同名原图、清空预览目录或批量重建其余 290 个对象。随后逐个生成：

```bash
docker compose exec app /app/media-previews -object e5ccac75-2fdb-41c3-8c63-39996e909ed3 -apply
docker compose exec app /app/media-previews -object a83e15e0-6559-4bbd-849d-4be3a40c2249 -apply
docker compose exec app /app/media-previews -object 8c048ada-c3c5-4fe5-84c8-377a55caf81b -apply
docker compose exec app /app/media-previews -object 9b9a35e5-ea32-4fce-ac73-4b48a9a22a01 -apply
```

报告应为 `generated`、`format: png`；检查 PNG alpha 通道、近白像素占比与画板白色内容可见性。已有旧 JPG 未移走时仍为 `existing/jpeg`，不会自动替换。用同一 `?v=2` URL 和旧 ETag 强制重新校验，新文件返回 200 与新 ETag，未变化再次请求返回 304；普通刷新最多有五分钟缓存窗口。原图 SHA-256、数据库与云对象保持原状。

## 部署验收与回滚

先补齐目标画布的缓存，再以同一账号、浏览器和画布对比冷/热缓存的请求数、传输量与打开时间。未补齐时 404 会回退原图，因此首次冷启动仍可能读取大图；不能宣称部署后立刻没有 `/content` 请求。目标画布规模与历史 228 MiB 传输量来自部署端报告，尚需现场复测。

确认节点、两种编辑器 chip、引用菜单、视频参考选择器、引用浮层、节点侧栏与助手列表使用预览；双击后原图加载失败仍保留预览并可重试，上一张/下一张的旧回调不能串图，预览转原图保持同一显示区域。浏览器真实网络、解码与首帧耗时须部署后验收，jsdom 只证明 DOM 状态行为。

核对 PNG／透明 PNG／JPG／自动选择不变，下载与编辑参考的 SHA-256、字节数不变，节点持久化不含 `/preview`。保留现有备份，不用降低原图质量处理卡顿。需要关闭画布预览时，将 `canvas-image-preview.ts` 的 `CANVAS_IMAGE_PREVIEWS_ENABLED` 设为 false 并重新构建；原图引用始终有效。

上传/直传的原图是否也强制保留本地副本是独立产品决策，本次不改变其云端存储策略；参考 [媒体巡检与同步维护](media-sync-recovery.md)。
