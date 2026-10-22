---
title: GitHub 镜像上传
description: 把 Gitea 主仓同步为 GitHub 上的干净 main 快照
---

# GitHub 镜像上传

本仓库以 Gitea 为主仓，GitHub 只是上传副本，不在 GitHub 上开 Issue、跑流水线或日常维护。

## 一键上传

```bash
brew install git-filter-repo   # 首次使用前安装一次
./scripts/push-github.sh
```

脚本从 Gitea 主仓的当前开发分支克隆一份临时仓库，重写提交历史后推到 GitHub `main`，结束自动清理临时目录。可用环境变量覆盖默认值：`BRANCH`、`UPSTREAM`、`GITHUB_URL`、`SOURCE_REPO`。

## GitHub 副本会剔除什么

- Gitea 端 CI 配置目录（`.gitea/`）：GitHub 不执行它，且会暴露内部 Runner 与镜像仓库地址。
- `outputs/` 下的定价产出物。
- 私有镜像仓库域名：所有历史提交里的域名替换为 `registry.example.com:4443` 占位符。
- 文档里指向已删除 CI 文件的句子同步改写，避免 GitHub 上出现失效路径。

## 注意事项

- 历史经过重写，GitHub `main` 与 Gitea 分支的提交 SHA 永久不同，同步必须强推；脚本用远端当前 SHA 做 `--force-with-lease` 租约，不会覆盖他人在 GitHub 上的推送。
- GitHub 上的 Actions 已在仓库设置里关闭，推送不会触发构建；如需恢复，在仓库 Settings → Actions → General 里启用。
- 只重写 GitHub 副本，Gitea 主仓的工作区和历史不受影响。
- 若 GitHub 副本 `main` 被删除，脚本会按普通推送创建分支。

