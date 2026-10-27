---
title: 画布保存会话、多窗口写权与引用同步不变量
description: 保存权按账号判定、同画板单写者、引用清理不反向改选中——三条都曾被破坏并造成数据丢失
---

# 画布保存会话、多窗口写权与引用同步

本文固定三条容易反复踩到的边界。每一条都对应一次真实事故，改动前先读完。

## 一、保存会话身份是账号，不是 JWT

1. 会话身份判据是**账号 id**（`user.id`，匿名为 `anonymous`）。`loadedProjectRef` 形如 `{ id, ownerId }`，不得记录或比较 token。
2. JWT 会因重新登录、第二个标签页、用户信息刷新而轮换。**token 变化不得中断保存，也不得触发画板重新加载**——重新加载会用服务端副本覆盖内存中尚未保存的编辑。
3. 三处入口共用同一判据：`flushCurrentCanvas`（pagehide / visibilitychange 兜底）、自动保存 effect、媒体修复 effect。长生命周期回调通过 `currentAccountIdRef` 读取实时账号。
4. 加载期间的保存抑制由 `restoringProjectRef` 表达，必须用世代号（`restoreGenerationRef`）在 `finally` 释放：只有最新一次加载可以解锁，`isCurrentRestore()` 为假的早退路径同样要释放。
5. 禁止把「保存被跳过」实现成无日志、无提示的静默 return——事后无法与「没有改动」区分。当前实现带 10 秒停摆哨兵：有未保存改动且长时间未落盘时自动重试并提示。

事故对照：token 轮换后保存守卫永久失效且静默，编辑 40 分钟未上传，重载后被旧版本覆盖。

## 二、同一画板在浏览器内只允许一个写者

1. 锁的粒度是 `(账号, 画板 id)`，实现为 localStorage 租约（`infinite-canvas:writer:<owner>:<project>`），心跳 3 秒、租约 10 秒；BroadcastChannel 只用于提前唤醒，**存储才是权威**。
2. 只读窗口必须显式可见（横幅 + 「在此窗口接管编辑」按钮），不得静默禁用交互。
3. **只读窗口绝不写服务端**：`flushProjectSave`、`queueProjectSave`、本地持久化三处都检查 `hasCanvasWriteAccess`。
4. 只读窗口仍要能**查询并展示**已提交任务的生成结果——轮询的身份判据只比账号，不掺杂写权。
5. 协调失败（Channel 报错、存储异常）必须降级为「可编辑」并提示，不得永久锁死画板。
6. 本锁只覆盖同一浏览器、同源、共享存储的窗口。跨设备并发仍由服务端 CAS 与冲突草稿兜底。

## 三、引用与选中之间不得双向自由同步

1. 回调必须带来源：`onReferenceIdsChange(ids, reason: "prune" | "user")`。**自动清理（prune）只改文本，绝不反向改画布选中**；只有用户主动删 chip（× 或退格）才取消对应节点的选中。
2. 同一 tick 的多次反向写入用 `queueMicrotask` 合并，且**内容相等就不提交**（比集合内容，不比 size）。
3. 下游 effect 的依赖用内容型 key（排序去重后 join），数组实例变化不得触发重跑。
4. 面板挂载条件（`assistantMounted`）与保存链路不在本机制内，不得顺带修改。

事故对照：新增「引用移除时取消选中」的反向同步后，框选时选中集合每帧变化 → chip 被判 stale 自动删除 → 回调上层 deselect → 再次改选中集合，形成环直到 React 更新深度超限，整个画布子树被卸载（表现为 Agent 面板消失）。

## 四、批量下载的文件名必须唯一

1. 文件名固定为 `canvas-<type>-<nodeId>.<ext>`，唯一性来自 `nodeId`；**不得使用提示词、标题或时间戳作为唯一标识**——同一批图提示词相同，会导致互相覆盖（实测 6 张只剩 4 张）。
2. 选中多个媒体时打包成一个 zip（`<画板标题>-选中<N>个-<时间戳>.zip`），避免浏览器「允许下载多个文件」拦截；只选中一个时才直接保存单文件。
3. 下载不是写操作：只读窗口也必须能用批量下载，不得用 `requireCanvasWriter()` 拦截。
4. 云端素材（`server:` 或 `/api/files/<id>/content`）必须先 `fetch` 成 blob 再写入 zip，不能只写 URL 字符串。

## 确定性守卫

- `web/src/lib/canvas-token-rotation.test.mjs`：保存会话身份按账号、restore 依赖不含 token、加载锁按世代号释放、停摆哨兵存在。
- `web/src/lib/canvas-writer-lock.test.mjs`：双开只一个写者、接管降级、关闭/崩溃后租约过期接管、账号隔离。
- `web/src/lib/canvas-assistant-reference-sync.test.mjs`：prune 与 user 严格区分、连续 20 次框选级选中变化不反向写、内容相同不提交。
- `web/src/lib/canvas-selected-download.test.mjs`：单选直存、多选打包、命名含 nodeId、失败收集。

新增用例必须在旧实现上产生**业务断言失败**，不能用编译失败或环境缺失（如 worktree 缺 gitignored 文件）替代。
