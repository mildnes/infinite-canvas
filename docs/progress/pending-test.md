---
title: 待测试
description: 当前版本已实现但仍需人工验证的变更项
---

# 待测试

- 配置 `grok2api` 或 `xai` 渠道后，画布用 grok-imagine-image / grok-imagine-video 系列模型生成图片、视频，确认路由、字段和轮询结果识别正常。
- 管理端/本地渠道协议下拉可选 `Grok2API`、`xAI`，保存后渠道协议字段正确落库。
- grok2api 渠道经 `/api/v1/tts` 调用 TTS，确认 `language` 缺省为 `en`；`/audio/speech` 保持 OpenAI 字段透传；音色列表可从 `/tts/voices` 拉取。
- 管理端 grok2api/xai 渠道“读取模型”：上游 `/models` 有结果时保留 LLM，并合并内置媒体目录；上游失败时回退内置文本+媒体目录。账号实际权限需人工核对。
- 渠道协议仍为 `openai` 但模型为 `grok-imagine-video-1.5` 时，创建视频不再 404，应映射到 `/videos/generations`。
- Grok/xAI 图片 prompt（含系统提示词）超过 8000 字符时，前端/后端应给出明确错误，不再透传上游 400。
- Grok 图生图多参考图应传 `images:[{url}]`，不再误映射为视频字段 `reference_images`；非法 `aspect_ratio`/`quality`/`size` 会被清洗。
- Grok 视频：`image` 与 `reference_images` 互斥；**首帧单图（含 video-1.5）可选 1080p**；**仅多参考图模式最高 720p**；视频 `21:9` 吸附为 `16:9`。
- Safari 打开画布视频应能播放；若节点 content 仍是 /api/proxy-image?url=视频地址，前端会解成直链。
- 本地生成/上传图片后点“上传至云存储”，图片应仍可显示（content 为 /api/files/.../content 或可用预览，不应变 X）。
- 更换 WebDAV/S3 地址后，旧 providerId 的云端图应仍能通过当前存储回源显示；上传至云存储后当前页不应立刻变 X（可先本地预览）。
- 打开画板：本机 IndexedDB 本地媒体应自动上传 WebDAV/S3 并回写 server:；已有 server: 直接显示；Grok 等 https 原链只显示不自动转存。
- 节点/工具栏「上传至云存储」「一键上云」可将本地未上云与 Grok https 主动转存为 /api/files/...；另一浏览器同账号应可见。
- 失效 blob 且无 server/原链时显示失效占位，不白屏；保存/同步 JSON 不含 blob:。
- Safari 打开 content 为 /api/files/.../content 的云端视频/音频应能正常播放（需支持 Range）。
- gpt-image-2 等仅返回 base64 的生图：所有画布生成、批量生成、重试与轮询完成路径会先写入 `server:` 或 `image:`；刷新浏览器后图片仍在。有对象存储时确认节点为 `server:`，无存储时至少有 `image:` 本地键。
- 打开画板恢复本地 Base64 媒体时，同一文件若同时存在于节点、Agent 历史图片或引用中，WebDAV/S3 只上传一份，所有引用回写同一个 `server:` 指针。
- 旧版本已丢失 content 但仍保留 `imageTaskId` 的成功图片，登录后打开画板应批量从云端任务记录取回结果并写入 `server:` 或 `image:`；任务记录不存在时维持失效占位，不扫描 WebDAV 目录猜测文件。
- Agent 对话框输入 @ 可弹出画布图片/视频/音频列表；插入芯片后发送，Agent 应识别对应节点引用。
- 画布选中图片/视频/音频时，Agent 输入框上方应显示附件缩略图并随本轮发送；输入 `@` 明确引用时以 `@` 引用为准，不叠加其他选中节点。选中 group 或图片批次时应展开其中可用媒体。
- 后台私有设置新增画布 Agent 扩展：可新增/启停/编辑 Skill，新增/启停 MCP 服务，读取工具列表；保存后 API Key 脱敏并可沿用。
- 画布 Agent 会话应自动加载启用 Skill 与 MCP 工具，模型可调用 `mcp__<服务>__<工具>` 工具，后端转发 JSON-RPC `tools/call` 并把真实结果回传模型继续执行。
- 用可生成视频的 MCP 工具走 Agent 生成视频并落回画布，确认工具参数传递、媒体 URL/文件结果能被模型识别，并通过 `create_media_node` 创建视频节点。
- 后台 MCP 分别配置 `Streamable HTTP` 和 `stdio`；HTTP 服务验证初始化/会话头，stdio 服务验证进程复用、异常重启和工具调用。
- Agent 输入 `/` 应能筛选并引用内置 Skill、后台 Skill；Skill 芯片只作用本轮，重试历史消息时仍能带回对应 Skill。
- 管理后台使用“从 GitHub 安装”输入仓库地址或 `SKILL.md` 地址，确认名称、描述、正文和来源信息正确保存，刷新后仍可启停并被 Agent 使用。
- 画板上传图片：云端 WebDAV/S3 异常时不应整页失败；应提示真实错误并回退本地保存，节点仍可上画布。
- 登录用户首次进入且后台允许云端渠道时，应直接使用后台默认文本、图片、视频、音频模型；用户在配置页主动切换“本地直连”后，后续登录应保留该选择。
- Gemini 协议渠道应能调用原生文本、图片、视频和 TTS；MiniMax H3 官方协议应能创建、轮询视频任务。
- 图片渠道的 `apiMode=chat` 应通过 Chat Completions 生图并正确解析图片结果。
- 未登录使用个人 S3/R2 或 WebDAV 时，Base64 生图刷新后仍可恢复；WebDAV/S3 媒体读取应按 Range 按需分段，Safari 视频/音频可播放。
