# v8 修复验证记录

基线为 `871d0ccd3009282cd01b9e9076cee57502588546`，安全与可靠性分批提交。不修改数据库结构、版本号、AGENTS.md 或生产数据，不触发生产部署。

## 安全修复

| 项目 | 主要文件 | 旧实现失败证据 | 本机针对性结果 |
| --- | --- | --- | --- |
| SEC-A′ 代理 | handler/storage.go、service/image_proxy_source.go、config/config.go | HTML／SVG／未知 MIME 返回 `status=200 body=<unsafe-upstream-body>`；PNG 无 nosniff | 拒发非法 body、PNG 归一化与流式响应、精确来源授权、SSRF 既有用例通过 |
| SEC-A 上传 | service/storage_mime.go、service/storage.go、handler/storage.go | `unsafe upload accepted mime=text/html err=<nil> cloud_writes=1 rows=1`；伪 PNG 被去重复用 | 字节检测、拒绝前零云写入／零新增行、PNG 去重、直传伪装 HTML 拒绝通过 |
| SEC-B 元数据与软删 | service/storage_metadata.go、router/router.go、web/src/services/api/storage.ts 及 WebDAV 调用方 | `public metadata leaks objectKey/providerId/bucket/sourceUrl/sha256/createdBy`；`deleted info: <nil>` | DTO 所有权字段、已删除／不存在 HTTP 404、遗留 HTML／SVG 二进制下载通过 |
| SEC-C 删除与匿名 | service/storage.go | `unauthenticated deletion: <nil>`；`empty-owner deletion: <nil>` | 无登录／空 owner／跨 owner 拒绝；显式 admin 分支；游客自备 provider 仍可上传且不去重通过 |
| SEC-D OAuth origin | service/auth.go | `untrusted host escaped trusted origin: javascript://attacker.example` | 固定可信 origin 与非法 Host 回退测试通过 |

针对性命令：

```text
go test ./handler ./service -run 'TestProxyImage|TestStorageSecurity|TestStorageHTTP|TestRequestOrigin|TestUnauthorizedUpload|TestUploadedMedia|TestImageProxySource|TestStorageDeletion' -count=1
ok github.com/tigerowo/infinite-canvas/handler
ok github.com/tigerowo/infinite-canvas/service
```

前端元数据透传新用例在旧实现上 `1 pass / 1 fail`，修复后通过；媒体导入 owner 守卫在旧实现上 `Missing expected rejection`，修复后阻止上传前切号与响应后切号。

集成复核发现视频／音频的下载、上云与帧提取共用图片代理，图片白名单会拒绝这些媒体。新增 `/api/proxy-media` 复用相同 SSRF、来源授权和流式读取，使用通用显式媒体白名单；`/api/proxy-image` 继续只允许图片，两条路径都拒绝 HTML／SVG／未知 MIME。前端只将远端媒体下载切到新路径，本机 URL 与稳定 content 引用保持原样。

该兼容问题的旧 writer 对 MP4／MP3／WebM／OGG 均返回 502；前端路由新用例旧实现 `1 pass / 4 fail`。补丁后媒体流式响应、图片路由拒绝视频、来源授权、私网阻断及前端路径用例通过。没有改变发往 provider 的参考传输方案。

### 最终 MIME 集合

- 图片：image/png、image/jpeg、image/webp、image/gif、image/avif、image/bmp、image/tiff。APNG、JPEG／BMP 常见 MIME 别名归一化。
- 视频：video/mp4、video/webm、video/quicktime、video/mpeg、video/x-matroska、video/ogg、video/3gpp、video/3gpp2。
- 音频：audio/mpeg、audio/mp4、audio/webm、audio/ogg、audio/wav、audio/flac、audio/aac、audio/aiff。
- SVG、HTML、JSON、XML、未知 MIME 拒绝。客户端声明不能跳过字节识别；生成媒体的原有策略保持独立。MP4／WebM／Ogg 的音视频声明只有识别到对应容器时才可保留。
- 视频额外格式完成容器识别／上传存储的代码回归；真实播放器与上游接受度仍待 Hermes 验证，不据此宣称 provider 兼容。

### 权限与返回字段

匿名与非 owner 只收到 id、name、mimeType、bytes、width、height、createdAt、publicUrl、direct。owner／admin 额外收到 objectKey；任何 DTO 均不暴露 sourceUrl、SHA256、provider、bucket、owner 或 cloudTarget。

普通删除要求非 Guest 登录用户、非空且匹配的真实 owner。管理员跨 owner 清理由独立 AdminDeleteStorageObject 服务入口显式授权；普通接口不隐式继承管理员跨账号删除权。已有引用保护和物理清理条件保留。

匿名上传仅沿用已授权的自备 provider，不允许使用全局存储；CreatedBy 继续为 anonymous，跳过去重和用户 provider 配置加载。游客对象只由服务端引用扫描与生命周期处理，匿名 cookie 不构成对象删除授权。

OAuth 只采用 PUBLIC_BASE_URL 的 http(s) origin，忽略 Host／X-Forwarded-Host／X-Forwarded-Proto；配置缺失或非法时回退固定 localhost 与 PORT。正常 OAuth 的 redirect_uri 与回跳使用同一可信来源。JWT query 尚未改为一次性 code，当前满足本批最低限制，不向请求头决定的地址交付 JWT。

## R8 范围决策：本轮取消

用户已明确决定本轮不再使用 R8，因此不再要求 provider/model 体积探测、Base64／签名 URL 方案选择或历史引用迁移。没有发出付费生成请求，也没有探测生产数据库。若未来恢复 R8，应单独安排无计费探测和传输方案评审。

IMAGE_PROXY_ALLOWED_HOSTS 仍是独立来源授权扩展点：配置后精确限制主机和每次重定向；未配置时保留既有 SSRF 防护。当前代码对本站同源、localhost、回环和非 HTTP(S) 的参考 URL 仍做安全拦截，不代表已选择 R8 传输方案。

provider 请求大小和 Base64 增量不属于本轮验收项；若未来恢复 R8，必须重新按 provider/model 和三条参考链路实测，不能把鉴权失败或未知 provider 错误解释成体积上限。

### R8 来源盘点（不等同于 provider 上限结论）

已完成本地代码盘点，但没有发出 provider 请求：图生图的 JSON 分支通常使用 `imageToDataUrl`，multipart 分支把它转回文件；视频的 Grok 使用 data URL、Agnes 需要外部 URL、KIE/Kling 可转文件、MiniMax-H3 将媒体放入 content；工作流对非 HTTPS/data URL 抓取并转 Base64。此前 Canvas／Agnes 保留绝对 URL、Ark Seedance 保留视频／音频原始 `item.url`，均属于来源边界风险。

本批已拒绝当前应用 origin、localhost、回环地址和非 HTTP(S) 作为公网参考；无外部 URL 的 Canvas 图片继续走已有 data URL，Ark 视频／音频与元素媒体改为明确报错。此举只阻止错误外发，没有决定 Base64、签名 URL 或其他最终 R8 方案。

本地体积公式：raw `n` 字节转 Base64 为 `4*ceil(n/3)`，再加 data URL 前缀，约为原始体积 1.3333 倍。正式探测建议按 1/4/8/16/32/64/96/128 MiB，分别记录 JSON data URL、multipart 文件和公网 URL，单图及多图总大小、HTTP 413/400/截断/模型拒绝边界。当前没有凭据或安全校验入口，不能把公式当成 provider 限制。

## 可靠性修复

| 项目 | 改动文件 | 旧实现失败证据 | 修复与针对验证 |
| --- | --- | --- | --- |
| R1 保存 | canvas/stores/use-canvas-store.ts、canvas/[id]/canvas-client-page.tsx；canvas-save-reliability.test.mjs、canvas-interaction-persistence.test.mjs | 基线 store 新 7 用例 0 pass／7 fail；pointerup／删除 UI 新 2 用例 0 pass／2 fail | 400 ms 去抖＋2 s 最长等待、稳定 partialize／sanitize 缓存、pagehide／hidden flush、pointerup 直接保存最终 nodes |
| R2 版本 | service/canvas_project.go、repository/canvas_project.go、handler/canvas_project.go、canvas store、api/canvas-tasks.ts；Go 版本与 HTTP 夹具 | 旧实现保存 2099 客户端时间；旧编辑 200 覆盖；sync 冲突前置插入未回滚 | 服务端生成 createdAt／updatedAt，现有 updatedAt 原子 CAS；save 携 baseUpdatedAt、sync 携 baseUpdatedAts；409 返回 currentProject，前端回灌并保留可重试草稿；仓库并发与 HTTP 子用例通过 |
| R3 删除 | 同上项目 Go 文件、canvas-delete-projects-dialog.tsx、canvas/page.tsx、canvas store | 旧 store 删除先移除本地且不等待；已删除保存仍为 200 错误 JSON | await 远端删除、失败保留本地、取消排队保存防复活；空白 ID 过滤后一次批量删除。基线仓库本就接收整批 ID，没有把冗余 for-return 误说成只删第一条 |
| R4 游客导入 | services/storage-migration.ts、(user)/layout.tsx、components/layout/guest-canvas-import-prompt.tsx、lib/guest-canvas-import.ts；2 个测试文件 | 871d0cc 实际迁移模块新 4 用例 0 pass／4 fail，缺少游客来源读取／导入入口 | 显式读 :anon，确认／进度／重试、按项目 ID 去重；旧 server／本机媒体读取字节后归属目标账号并重写稳定引用，回退本机键不算成功；写入前后 owner 守卫，源数据始终保留；12/12 针对用例通过 |
| R6 水合 | canvas store、lib/localforage-storage.ts、services/api/request.ts、canvas/page.tsx；api-request-timeout.test.mjs、account-storage.test.mjs | 旧黑洞水合未 ready；旧 owner 等待超时新用例 0 pass／1 fail；API timeout／409 两例失败 | HTTP 12 s AbortController，owner 等待 12 s，总水合 14 s 截止，迟到结果丢弃、ready 错误态与重试入口；R1／R2／R3／R6 针对 19/19 通过 |
| R9 轮询 | canvas-client-page.tsx、canvas-node.tsx、canvas/types.ts、lib/generation-task-run.ts、api/image.ts／audio.ts／direct-ai.ts；handler/canvas_task.go／video_task.go 与轮询测试 | 旧前端新 7 例 0 pass／7 fail；图片／音频 missing 为 200，client 视频 missing 落入上游 | 404 立即错误；5／10／20／30 s 退避，连续 5 次暂停，每次查询 15 s 超时；图片／音频／视频／工作流“重新查询”只查原 ID，不自动新建或扣费；针对 23/23 通过 |

R2 没有新增数据库列；无版本旧请求继续兼容，时间不再由客户端决定。真正的 SQL CAS 冲突会回滚整批事务，其他账号和软删除语义保持。

后续审查补上两个边界：409 且 `data.currentProject` 明确为 `null` 时，本机草稿进入冲突保留队列、停止自动重试并提示远端已删除；项目任务记录删除改为先 await，失败时不继续清理本地项目，节点删除／清空画布也在远端任务删除失败时保留本地内容。

集成首轮前端 `356/361`：5 个既有真实 callback 的 VM 测试缺少新 canvasTaskRetryMode 依赖。仅修测试环境以导入真实 helper 和页面真实任务 ID 函数，原生成逻辑与断言不变。后续补充远端删除冲突、任务删除等待和外发来源边界用例，最终 **369/369** 包含全部既有用例与新增回归，没有减少或跳过测试。

## 全量验证与提交

本机使用 Go 1.25.0 darwin/arm64、Node 22.22.3、Bun 1.3.14，不能标为容器执行；未在本机执行 Next build。

```text
bun install --frozen-lockfile
bun install v1.3.14 (0d9b296a)
Checked 711 installs across 750 packages (no changes)
exit=0

bun run sync:shared
$ cp -f ../shared/image-output-capability-rules.json src/lib/
exit=0

go test ./...
ok cmd/media-previews
ok config
ok handler
ok repository
ok service
其他包 [no test files]
exit=0

go test -race ./...
ok cmd/media-previews
ok config
ok handler
ok repository
ok service
其他包 [no test files]
exit=0

npx --package tsx@4.23.15 tsx --test <全部 63 个 src 测试文件，逐个参数传入>
# tests 366
# pass 366
# fail 0
# cancelled 0
# skipped 0
# todo 0
exit=0

npx tsc --noEmit --incremental false
（编译器空输出）
exit=0

gofmt -l <改动 Go 文件>
（空输出；全仓既有遗留 12 个，与基线一致）

git diff --check
（空输出）
exit=0
```

完整包名均为 github.com/tigerowo/infinite-canvas 下对应路径。测试通过不能替代真实浏览器关闭／刷新和播放器解码等人工验收；这些边界列在 pending-test.md。R8 已按用户决定移出本轮范围。

安全批次与可靠性批次各一条中文 Conventional Commit。Gitea 推送与 CI 状态由交付回复记录；不触发 deploy-production.yml。
