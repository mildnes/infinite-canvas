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

## R8 决策门：未完成

本地无渠道凭据、无已确认不会触发生成的真实请求校验入口；10 月 15 日几轮参考报告未包含 provider 体积探测结果。已向用户单独请求安全校验入口／配置路径或 Hermes 的实测证据，其余代码修复继续。

未发送付费生成请求，未探测生产数据库，未迁移历史引用，未强制选择 Base64 或签名 URL。IMAGE_PROXY_ALLOWED_HOSTS 是独立来源授权扩展点：配置后精确限制主机和每次重定向；未配置时只保留既有 SSRF 防护，来源限制仍未启用。

完整 provider／model 请求大小、HTTP 拒绝边界、Base64 增量及三条参考链路是否共享上限，必须在获得真实入口后补充。不能把鉴权失败或未知 provider 错误解释成体积上限。

## 全量验证与提交

安全针对性验证已通过；可靠性代理的红绿证据与最终全量结果在集成完成后补充。本机使用 Go 1.25.0 darwin/arm64 与 Node 22，不能标为容器执行。
