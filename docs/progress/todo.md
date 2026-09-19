---
title: TODO
description: 当前项目后续值得处理的事项
---

# TODO

本文档用来记录当前项目后续比较值得处理的事项。

## 数据库与媒体存储后续

- [ ] 对旧版 `image_generation_logs.payload_json` 做可见性与恢复引用分类，设计幂等的内联媒体迁移；当前工具只统计日志规模。
- [ ] 完善生成媒体在任务、项目、素材、日志、撤销历史、Skill 与会话间的全局引用回收与云同步失败重试；当前代码为避免误删保留本地副本。
- [ ] 单独安排生产停写、数据库及媒体目录备份和验证、限量迁移、抽样恢复、空间评估与 `VACUUM`，不得在普通开发流程中执行。

## 已完成（待人工验证，见 pending-test.md）

- [x] grok2api/xAI 路由协议：`/videos` -> `/videos/generations`，图片、轮询、audio 保持同路径。
- [x] grok2api/xAI 请求归一化：多参考图 `reference_images:[{url}]`、单图/首帧 `image:{url}`、参数透传、`/tts` 默认 `language=en`。
- [x] 管理端 grok2api/xai 渠道内置 Grok 模型目录。
- [x] grok2api/xAI 协议测试（路径、图片、视频、TTS）。
- [x] 渠道协议静态模块：保留 OpenAI、Gemini、Grok2API/xAI、Metaso、KIE、APIMart、MiMo 的现有路由、鉴权、模型目录和任务适配。
- [x] 画布 Agent 支持后台 Skill 工作流与 MCP 工具：Skill 追加系统提示，MCP 由后端 JSON-RPC 代理调用。
- [x] 合并上游 v0.6.0 Agent、Skill、画布媒体与视频交互能力，保留 Grok/xAI、云端存储和 MCP 定制。
- [x] 选择性合并上游 v0.7.1 画布媒体修复、Agent 节点交互和独立 Ark Seedance 协议，保留现有 Grok/xAI 与媒体恢复链路。
