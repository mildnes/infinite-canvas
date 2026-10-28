---
title: 接口响应约定
description: 业务接口统一响应结构与前端处理约定
---

# 接口响应约定

后端业务接口统一返回 JSON：

```json
{
  "code": 0,
  "data": {},
  "msg": "ok"
}
```

- `code`: 业务状态码，`0` 表示成功，非 `0` 表示失败。
- `data`: 业务数据。失败时通常为 `null`。
- `msg`: 响应消息。成功默认为 `ok`，失败时放错误原因。

前端请求逻辑以 `code` 判断业务是否成功。当前后端业务失败也会返回 HTTP 200，前端不要只依赖 HTTP 状态码判断结果。

接口连接失败、服务不可达、返回体不是约定 JSON 时，前端按网络或接口异常处理。

## 后台日志接口

后台日志接口位于 `/api/admin` 下，统一使用管理员鉴权并返回标准 `{ code, data, msg }` 响应。

### AI 调用日志

- `GET /api/admin/ai-logs`：支持 `keyword`、`page`、`pageSize`，返回 `{ items, total }`。列表项只包含 `id`、`createdAt`、`userId`、`userDisplayName`、`endpoint`、`method`、`model`、`channelId`、`channelName`、`status`、`durationMs`、`credits`，不包含 `requestBody`、`responseBody`、`error`。
- `GET /api/admin/ai-logs/:id`：按需读取完整记录，包含请求正文、规范化后的返回正文和失败原因；格式与失败原因前缀规则沿用原日志详情。记录不存在或已被清理时返回 HTTP 404，`code` 为非 `0` 且 `data` 为 `null`。
- 无关键词列表查询使用日志文件摘要缓存；首次访问仍需完成全部日志文件的索引建立。有关键词时仍扫描原始请求正文、返回正文和错误正文，匹配不区分大小写，不能把摘要缓存当成正文搜索索引。服务端不引入 Redis：内存索引只保留摘要、记录 ID、字节偏移和长度，正文按详情或搜索需要读取，不常驻缓存。摘要与正文按日期写入 `AI_LOG_DIR` 下的 `ai-calls-YYYY-MM-DD.log`。
- 新写入日志在截断前先脱敏大段 Base64／字符串；截断后的正文可能保留说明性占位文本。历史文件不会自动改写，旧记录详情仍可能包含截断 Base64，读取时统一脱敏展示，但磁盘大小不变。旧日志全文搜索仍会扫描这些历史正文，可能较慢。
- 前端列表缓存按登录身份、已提交条件、页码和页大小隔离，只在内存保留；列表新鲜期为 30 秒、回收时间为 5 分钟。详情仅在用户打开请求／返回内容时加载，详情缓存新鲜期和回收时间均为 5 分钟。切换身份会清理旧身份缓存，失败时保留已有列表数据。

### 算力点日志

- `GET /api/admin/credit-logs`：支持 `keyword`、`page`、`pageSize`，返回 `{ items, total }`，按 `created_at` 倒序、`id` 倒序分页。
- 关键词搜索继续匹配用户、类型、备注和关联 ID，行为与改动前一致。当前使用包含匹配，`(created_at, id)` 索引只服务普通排序，不会降低关键词搜索的全表扫描成本。
- 算力点余额和扣点查询不增加服务端缓存。

## 画板流式导出

- `POST /api/v1/canvas/projects/:id/export`：使用 Bearer 登录鉴权，仅允许本人未删除画板。画板只含云端素材时返回 `{ mode: "server", url, expiresAt }`；节点、批量子图或聊天会话仍引用浏览器本地素材时返回 `{ mode: "browser", localAssetCount }`，不签发无效票据，由前端改用兼容导出。不存在、他人或软删除均为 HTTP 404。
- `GET /api/v1/canvas/projects/:id/export?ticket=...`：浏览器原生下载入口，无需 Authorization 头。票据经 HMAC 签名绑定账号和画板，5 分钟有效、仅可消费一次；签名无效、过期、跨画板或重放均为 HTTP 403。待用票据只保存在签发进程内，服务重启后需重新申请。
- GET 成功直接返回 `application/zip` 和附件文件名，无 JSON 外层、无 `Content-Length`；ZIP 内先写 version 3 的 `projects.json`，再逐个写 `projects/<projectId>/files/<objectId>.<ext>`。每个对象必须属于票据账号，缺失／越权／读取失败写入 `missing.json`，不打开已知越权对象的内容。
- ZIP 流开始后不追加 JSON 错误。客户端取消或 10 分钟总时限到达会中止读取和输出，下载不完整时需重新申请票据；前端提示用户检查包内 `missing.json`。

## 生图工作台历史接口

- `GET /api/v1/generation-logs/images/page?limit=40&cursor=...`：返回 `{ items, nextCursor }` 轻量摘要页，不包含 Base64 和完整请求响应。
- `GET /api/v1/generation-logs/images/:id`：用户点击载入时读取当前账号的完整记录。
- `POST /api/v1/generation-logs/images/upsert`：每批最多增量保存 40 条记录，不返回整份历史。
- `POST /api/v1/generation-logs/images/workbench-delete`：批量软删除当前账号的历史和对应工作台任务；云端原文件只进入延迟回收候选。
