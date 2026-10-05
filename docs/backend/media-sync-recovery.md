# 媒体巡检与同步维护

可使用 `/app/media-verify` 检查本地、所属云端和同 SHA-256 兄弟副本，并在停写后修复缺失副本。媒体 ID、`server:` 和画布短链接不变。命令不删除原媒体、不压缩数据库；恢复成功仍需在浏览器验证画布和播放。

## 上线前提

先部署包含新命令的镜像，让应用完成 `storage_objects` 新字段初始化；确认数据库、媒体目录及独立备份可恢复。旧数据库的维护连接不会自动建表或迁移，缺少相关字段时应先完成部署，不能用写入修复试探。

生成结果仍先落本地。后台 `storage.autoSyncAllAssets` 决定是否自动上云，显式补传不依赖该开关，但本地对象仍须符合所属账号及用户/全局提供方权限。后台关闭自动同步时暂停自动任务，已入队的显式任务继续使用原目标。

## 同步状态

对象元数据增加同步和检查状态，字段定义见 [数据库结构](backend-database.md#storage_objects)。

- `pending`：已经记录固定目标，等待执行。
- `syncing`：已领取租约，默认最多两个对象同时上云；租约三分钟到期，每分钟续租。
- `retry`：暂时失败，`cloudSyncError` 给出脱敏原因，`cloudSyncNextRetryAt` 给出下次时间。
- `verified`：目标完整回读通过字节数及 SHA-256 校验。
- `blocked`：无权限、配置改变、内容冲突或重试耗尽等，需要显式处理。

首次失败后依次等待约 1 分钟、5 分钟、15 分钟、1 小时、6 小时，带少量抖动；每个入队周期最多六次尝试。启动时及随后每分钟检查队列，不主动扫描或上传全部历史对象。进程中断后接管过期租约；对象删除、索引变化或目标配置变化时拒绝迟到回写。

`cloudSyncedAt` 是曾经完整确认同步成功的时间，不能证明文件现在仍存在；空值也不能证明旧文件从未上传。`cloudCheckedAt/cloudCheckStatus` 是最近检查结果，`cloudVerifiedAt` 是最近完整回读成功时间。检查必须读取对象所属 provider 的原 bucket/key；应用 `/api/files/<id>/content` 会回退本地，不能拿它的 200 代替云端验证。

## 只读巡检

以下参数已在代码中实现；本轮开发未执行部署构建或生产巡检。

```bash
docker compose exec app /app/media-verify -limit 10 -workers 2
docker compose exec app /app/media-verify -object-id <OBJECT_ID> -limit 1
docker compose exec app /app/media-verify -provider-id <PROVIDER_ID> -limit 100 -after <LAST_OBJECT_ID>
```

默认 dry-run 使用只读数据库连接，不创建目录、媒体临时文件或更新状态；读取完整媒体计算哈希会产生网络与磁盘流量。可用 `-user-id` 限定账号，`-limit` 范围为 1–1000，`-workers` 为 1–6，默认 2。根据汇总 `nextCursor` 逐页继续，直到当前筛选下 `inspected=0`。

每个对象完成后立即输出一条 JSON，随后输出汇总。逐条报告包含：对象/账号/provider/key、MIME、预期及实测字节与完整 SHA-256、检查前后状态、恢复来源/兄弟对象 ID、计划与完成动作、耗时和原因。状态为 `verified/planned/repaired/failed/skipped`；`planned` 只代表有可验证的修复来源，不代表已经修复。

缺少可靠字节数或 SHA-256 的对象返回 `skipped`，不建立虚假的内容基准。失败对象不阻断其他对象，但最终退出码为 1；参数错误退出码为 2。汇总分别统计失败、跳过及检查前的本地缺失、云缺失、双缺。

## 停写后的修复

先在测试环境验证，再核对生产 dry-run 报告并安排维护窗口。备份数据库和媒体，确认应用已停止写入；`-writes-stopped` 只是操作声明，不会自动停应用。

```bash
docker compose stop app
docker compose run --rm --no-deps --pull never app /app/media-verify -limit 10 -workers 2 -apply -writes-stopped
docker compose start app
```

只使用已经核对的新镜像，保留部署机现有 Compose 补丁和持久化挂载。按 dry-run 相同筛选逐页修复，完成后重新启动应用并巡检。

| 检查情况 | 行为 |
|---|---|
| 双方有效 | 不重复上传；apply 更新检查证据 |
| 本地缺失、云端有效 | 完整校验后回填本地 |
| 本地有效、云端 404 | 上传原 provider/bucket/key，再完整回读 |
| 双缺 | 尝试公开 URL 或同 SHA-256、同字节数的有效兄弟；先恢复本地，再补传原云端位置 |
| 401/403、超时、5xx、配置失效 | 报告不可达/受阻，不当作 404，不盲目 PUT |
| 本地或云端内容冲突 | 保留冲突文件并报告，不覆盖或删除 |

来源均需通过目标对象的完整内容校验。公开 URL 使用现有安全代理连接策略，不放开私网、metadata 或 TLS 校验。兄弟恢复只在有数据库维护权限的离线命令中执行，可借跨账号的内容等价副本，但不改归属和访问规则。已有本地文件也校验，不能只凭存在跳过。

回填写入同目录临时文件，验证并同步后原子安装到目标文件名；目标已存在时重新校验，不覆盖冲突。只清理本次临时文件。`localCopyRemovedAt` 标记了有意清理的本地副本，云端健康时默认不回填；确需恢复时增加 `-restore-removed-local`。云端也缺失时仍检查恢复来源。

## 显式补传和重试

默认巡检本地索引对象只验证本地，不替用户选云端。增加 `-sync-local` 后才预览/执行允许的上云目标：

```bash
docker compose exec app /app/media-verify -sync-local -limit 10
docker compose run --rm --no-deps --pull never app /app/media-verify -sync-local -object-id <OBJECT_ID> -limit 1 -apply -writes-stopped
```

`media-cloud -mode sync` 也复用完整检查与修复，并开启本地对象显式补传。现在扫描所有活跃对象，覆盖云索引存在但远端文件缺失的情况；**写入新增 `-writes-stopped` 要求**，旧的不停写补传命令需要调整：

```bash
docker compose exec app /app/media-cloud -mode sync -limit 10
docker compose run --rm --no-deps --pull never app /app/media-cloud -mode sync -limit 10 -apply -writes-stopped
```

失败后修复凭据或网络，再对同一对象显式执行；本地对象的显式补传重新计数并确认配置，固定目标路径不因日期变化而改变。对于配置正常但暂时失败的已入队任务，也可以由应用启动后的队列继续重试。已经登记云端的对象始终修复原目标，不自动转到其他存储。

`media-cloud -mode cleanup` 继续保留现有保留期、独立备份确认和双方完整校验。本轮不会执行清理，也不建立定时删除任务。

## 定期巡检与验收

每周任务先只运行 dry-run，分页保存 JSON 报告并关注 `failed/skipped`；不把 `-apply -writes-stopped` 放入在线生产 cron。写入修复由维护窗口单独执行。

部署/CI 应执行 Go 回归、`go build ./...` 和完整镜像构建，确认 `/app/media-verify` 可运行。测试环境分别制造上传失败、本地缺失、云端缺失和双缺，验证重试、幂等、内容冲突拒绝及只读零写入。上线后在真实浏览器验证画布刷新、图片编辑、视频/音频播放，并直接读取原云端对象核对完整字节；应用健康端点通过不能替代这些验收。
