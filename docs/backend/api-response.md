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

## 生图工作台历史接口

- `GET /api/v1/generation-logs/images/page?limit=40&cursor=...`：返回 `{ items, nextCursor }` 轻量摘要页，不包含 Base64 和完整请求响应。
- `GET /api/v1/generation-logs/images/:id`：用户点击载入时读取当前账号的完整记录。
- `POST /api/v1/generation-logs/images/upsert`：每批最多增量保存 40 条记录，不返回整份历史。
- `POST /api/v1/generation-logs/images/workbench-delete`：批量软删除当前账号的历史和对应工作台任务；云端原文件只进入延迟回收候选。
- `GET /api/files/:id/thumbnail`：返回最大 480 像素的 WebP 列表缩略图；失败时前端回退原 `/content` 地址。
