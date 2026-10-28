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
