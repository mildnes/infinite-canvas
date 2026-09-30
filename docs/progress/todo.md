---
title: TODO
description: 当前项目后续值得处理的事项
---

# TODO

本文档用来记录当前项目后续比较值得处理的事项。

## 数据库与媒体存储后续

- [ ] 对旧版 `image_generation_logs.payload_json` 中仅存内联媒体的记录做独立迁移；当前已支持轻量摘要回填，但不清理完整旧载荷。
- [ ] 在服务端能够确认浏览器 IndexedDB、离线画布和 Agent 会话引用后，再为云媒体候选开放物理删除；当前只登记并审查候选，始终保留云端原图。
- [ ] 生产任务媒体迁移已由部署端报告完成、画布图片已人工验收；另行安排备份转移、空间评估与 `VACUUM`，不得在普通开发流程中执行。

## 已完成（待人工验证，见 pending-test.md）

- [x] 画布 Agent 生图使用对话框所选图片模型与渠道，不再被云端默认模型覆盖。
- [x] 图片、音频、视频孤儿任务启动/定时收尾、终态防降级及前端超时中断展示。
- [x] 渠道生成成功媒体强制本地持久化、内容哈希去重、临时代理 URL 解析及历史画布 dry-run/apply 修复工具。
- [x] grok2api/xAI 路由协议：`/videos` -> `/videos/generations`，图片、轮询、audio 保持同路径。
- [x] grok2api/xAI 请求归一化：多参考图 `reference_images:[{url}]`、单图/首帧 `image:{url}`、参数透传、`/tts` 默认 `language=en`。
- [x] 管理端 grok2api/xai 渠道内置 Grok 模型目录。
- [x] grok2api/xAI 协议测试（路径、图片、视频、TTS）。
- [x] 渠道协议静态模块：保留 OpenAI、Gemini、Grok2API/xAI、Metaso、KIE、APIMart、MiMo 的现有路由、鉴权、模型目录和任务适配。
- [x] 画布 Agent 支持后台 Skill 工作流与 MCP 工具：Skill 追加系统提示，MCP 由后端 JSON-RPC 代理调用。
- [x] 合并上游 v0.6.0 Agent、Skill、画布媒体与视频交互能力，保留 Grok/xAI、云端存储和 MCP 定制。
- [x] 选择性合并上游 v0.7.1 画布媒体修复、Agent 节点交互和独立 Ark Seedance 协议，保留现有 Grok/xAI 与媒体恢复链路。
