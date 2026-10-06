# 画布图片预览副本

画布图片节点、引用标签和节点侧栏优先读取轻量 JPEG；全屏先展示预览，再加载原图。预览失败时回退原图，下载、生成参考图、编辑、Agent、导出和上云仍使用原始媒体。生图工作台不使用这条预览链路。

## 存储与生成

预览位于 `GeneratedMediaDir()/previews/<objectId>.jpg`，最长边 1024、JPEG quality 80；透明原图的预览铺白底，原图字节与透明通道不改变。对象 ID 对应不可变媒体，缓存首次有效写入保留，不覆盖已有预览。没有新增数据库字段或云端预览文件。

浏览器上传图片、生成媒体持久化和登录后的 WebDAV 直传注册时，使用已持有的 Blob 在后台生成预览，优先 OffscreenCanvas，兼容普通 Canvas；不会为了制作预览额外下载原图。浏览器最多两个编码任务，失败不影响媒体成功状态。提交绑定捕获的账号 token，账号变化后不提交旧任务；预览操作不回写画布节点。

服务端图片落盘、上传与直传注册完成后，延迟十秒排队兜底；未就绪的预览请求也可触发生成。队列最多 256 个对象、两项并发，同对象任务合并，失败冷却一分钟。读取优先使用本地原图，否则沿用已有对象读取链路和 SSRF 防护；对有字节数、SHA-256 的记录核对完整源文件。

服务端支持 JPEG、PNG、GIF、BMP、TIFF、WebP 解码，读取上限 128 MiB、解码上限 64 Mi 像素；不支持的格式或超限图片回退原图。浏览器支持的格式可先提交预览。视频、音频和全景查看器不改读取方式。极大图片的额外解码内存仍需部署端核对，不能以预览尺寸代替原图解码成本。

`previews/` 是可再生显示缓存，不能算作原图本地副本、恢复来源或完整备份。现有巡检、回填与清理根据对象原始扩展名定位文件，不扫描该子目录。此次不删除任何缓存、原图或备份。

## 接口

| 接口 | 行为 |
|---|---|
| `GET/HEAD /api/files/:id/preview` | 对存在且未删除的图片，缓存就绪返回 200、`image/jpeg`，支持条件请求和 Range；使用一年 immutable 缓存。缺失返回真正的 404、`no-store`，异步生成不阻塞响应。 |
| `PUT /api/v1/files/:id/preview` | Bearer 登录鉴权，只允许对象所有者提交完整 JPEG；最多 2 MiB，宽高各不超过 1024。重复有效提交不覆盖，返回标准成功信封。无权 403、对象不存在 404、格式/体积错误 400。 |

读取权限沿用现有公开 `/content` 路由，而非新增私有媒体权限。匿名对象依赖服务端兜底；未注册为对象 ID 的 `server:webdav:` 引用保持原读取。前端仅在展示位置派生 URL，不把 `/preview` 写进 `content`、Agent 原图引用或画板 JSON。

## 历史预览补齐

使用包含 `/app/media-previews` 的已核对新镜像和持久化媒体挂载。先在测试环境跑默认 dry-run：

```bash
docker compose exec app /app/media-previews -limit 100 -workers 2
docker compose exec app /app/media-previews -object <OBJECT_ID>
```

dry-run 只读数据库、检查现有缓存，不下载原图、不创建目录、不更新数据。报告每个对象的 `candidate/existing/skipped`；按候选每张 300 KiB 给出容量规划估计，实际 JPEG 大小需测量。`estimatedSeconds` 为 null，避免把未知的云读取耗时当作测试结果。

先显式生成一个小批次并检查实际 `durationMs` 和 `previewBytes`，再按实际吞吐规划其余批次：

```bash
docker compose exec app /app/media-previews -apply -limit 10 -workers 2
docker compose exec app /app/media-previews -apply -limit 100 -workers 2 -after <NEXT_CURSOR>
```

两种模式都使用只读数据库连接，apply 仅创建缓存。按汇总 `nextCursor` 续跑，直到 `scanned=0`。单对象失败会继续处理其他对象并返回退出码 1；失败对象需用 `-object` 单独重试或重跑本批。中断时游标只推进到连续完成的行，重跑已有缓存会跳过。此工具不执行迁移、媒体删除或 VACUUM，也不调用收费 AI 接口。

## 部署验收与回滚

先补齐目标画布的缓存，再以同一账号、浏览器和画布对比冷/热缓存的请求数、传输量与打开时间。未补齐时 404 会回退原图，因此首次冷启动仍可能读取大图；不能宣称部署后立刻没有 `/content` 请求。目标画布规模与历史 228 MiB 传输量来自部署端报告，尚需现场复测。

确认节点、两种编辑器 chip、引用菜单、视频参考选择器、引用浮层、节点侧栏与助手列表使用预览；双击后原图加载失败仍保留预览并可重试，上一张/下一张的旧回调不能串图，预览转原图保持同一显示区域。浏览器真实网络、解码与首帧耗时须部署后验收，jsdom 只证明 DOM 状态行为。

核对 PNG／透明 PNG／JPG／自动选择不变，下载与编辑参考的 SHA-256、字节数不变，节点持久化不含 `/preview`。保留现有备份，不用降低原图质量处理卡顿。需要关闭画布预览时，将 `canvas-image-preview.ts` 的 `CANVAS_IMAGE_PREVIEWS_ENABLED` 设为 false 并重新构建；原图引用始终有效。

上传/直传的原图是否也强制保留本地副本是独立产品决策，本次不改变其云端存储策略；参考 [媒体巡检与同步维护](media-sync-recovery.md)。
