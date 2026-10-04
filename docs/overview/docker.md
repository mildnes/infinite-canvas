---
title: Docker 部署
description: 使用 Docker Compose 部署无限画布
---

# Docker 部署

如果你希望在自己的机器或服务器上运行项目，可以直接使用 Docker Compose。

## 使用发布镜像

```bash
git clone git@github.com:tigerowo/infinite-canvas.git
cd infinite-canvas
cp .env.example .env
# 从 Gitea Actions 的 image-metadata.txt 复制完整 digest 引用
export IMAGE_REF='registry.example.com:4443/mildnes/infinite-canvas@sha256:<digest>'
docker compose pull
docker compose up -d --no-build
```

启动后访问：

```text
http://localhost:30101
```

默认管理员账号：

```text
用户名：admin
密码：.env 中的 ADMIN_PASSWORD
```

## 本地构建镜像

如果需要基于当前源码构建镜像：

```bash
cp .env.example .env
docker compose -f docker-compose.local.yml up -d --build
```

生产 `docker-compose.yml` 只拉取 `IMAGE_REF` 指定的 Gitea 镜像，不执行本地构建。镜像发布工作流位于 Gitea 仓库的 Actions 配置，只响应 `feat/grok2api-protocol` 分支；Go 测试、前端逻辑测试和真实 Next.js 生产构建全部成功后才推送 `linux/amd64` 镜像。工作流使用提交 SHA 标签、记录 digest，并通过 registry BuildKit 缓存复用构建层。

生产更新由 Gitea 仓库的部署工作流手动触发。触发时填入发布工作流产出的完整 `image_ref`，并输入 `DEPLOY` 明确批准；部署 Runner 需要 `self-hosted`、`linux`、`x64` 标签，并设置 `DEPLOY_DIR` 变量指向包含生产 `.env` 和 `data/` 的目录。部署前会记录当前容器镜像到 `.deploy/previous-image-ref`，不会清理上一版镜像，便于回滚。

Gitea 仓库需要配置 `REGISTRY_USERNAME` 和 `REGISTRY_PASSWORD` secrets；密码应使用具有容器包写入权限的个人访问令牌。不要把 `latest` 写入生产 `IMAGE_REF`。

## 数据目录

`docker-compose.yml` 会把本地 `./data` 挂载到容器内 `/app/data`，用于保存 SQLite 数据库、提示词数据和上传素材。

Docker 部署时建议把 `.env` 中的 SQLite 路径设置为：

```text
DATABASE_DSN=/app/data/infinite-canvas.db
```

如果需要让火山方舟拉取本地上传的 Seedance 参考素材，还需要把 `PUBLIC_BASE_URL` 设置为公网可访问的站点地址。
