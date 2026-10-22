<p align="center">
  <img src="web/public/logo.svg" width="96" alt="infinite-canvas logo">
</p>

<h1 align="center">无限画布 (infinite-canvas)</h1>

<p align="center">
  <a href="VERSION"><img src="https://img.shields.io/github/v/tag/mildnes/infinite-canvas?style=flat-square&label=version" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f97316?style=flat-square" alt="License"></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/Docker-ready-2496ed?style=flat-square&logo=docker&logoColor=white" alt="Docker ready"></a>
  <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16.2-000000?style=flat-square&logo=nextdotjs" alt="Next.js"></a>
  <a href="https://go.dev/"><img src="https://img.shields.io/badge/Go-1.25-00add8?style=flat-square&logo=go&logoColor=white" alt="Go"></a>
</p>

无限画布是一个以 AI 图片、视频和音频创作为核心的开源工作台，将画布编排、模型接入、参考图编辑、对话助手、提示词库和素材管理集中在同一个界面中。

本仓库是独立维护的二次开发项目，以 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) 和 [HuFakai/infinite-canvas](https://github.com/HuFakai/infinite-canvas) 为基础继续开发，不作为上游项目的 fork 同步维护。日常开发以 Gitea 主仓为准，GitHub 仓库仅用于公开上传，不接受 Issue、Pull Request 或分支协作。

本项目在原有纯前端方案上补充了后端服务、账号与云同步、视频生成链路和相关管理能力。项目仍在持续开发，数据库结构和存储格式可能调整，不保证历史数据兼容。

> [!CAUTION]
> 项目目前处于开发阶段，不保证历史数据兼容。各种数据库结构和存储格式都可能直接调整，欢迎关注后续更新
>
> 二次开发与分发请保留原作者信息和前端页面标识，并遵守 MIT License。

## 核心功能

- 全景图：支持文字生成、参考图生成和本地 2:1 全景图导入，可作为导演台的场景环境背景
- 导演台：在独立 3D 场景中布置角色、模型、全景环境和机位，支持镜头管理、截图，并将机位画面自动发送为连线图片节点
- 摄像机控制：图片、视频和生成配置节点支持独立设置相机、镜头、焦距和光圈，将镜头参数自动写入生成提示词，并随节点保存和复制
- 无限画布：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出
- AI 创作：支持 OpenAI 兼容接口的 Images API、Responses API、图生图、参考图编辑、流式接收、Base64 图片返回；Seedance 2.0 可通过火山方舟 Agent Plan 接入
- 生图工作台：支持侧边/悬浮底部工作台、多任务并发、历史结果合并展示、分类管理、失败详情、参考图缩略图、图片体积展示和“我的素材”复用
- 创作工作流：支持公开/个人模板、变量表单、AI 创建工作流、单图/多图系列工作流、参考图输入和结果自动进入生图历史
- 画布助手：围绕选中节点和上游节点对话、生图，并把结果插回画布
- 提示词库：抓取多个 GitHub 开源项目，按案例整理数百个图片提示词
- 提示词与素材：提示词库、服务器素材库和“我的素材”可在生图、画布 AI 和工作流中复用

完整功能说明见 [功能介绍](docs/overview/features.md)。

## 技术栈

- 前端：Next.js、React、TypeScript、Tailwind CSS、Ant Design、Zustand、TanStack Query
- 后端：Go、Gin、GORM
- 存储：SQLite、本地 IndexedDB、S3 兼容对象存储、Cloudflare R2  
- 部署：Docker

## 快速开始

```bash
git clone <Gitea 仓库地址>
cd infinite-canvas
cp .env.example .env
# 修改默认账号密码等信息
# 从 Gitea Actions 的 image-metadata.txt 复制完整镜像引用
export IMAGE_REF='<镜像仓库地址>@sha256:<digest>'
docker compose pull
docker compose up -d --no-build
```

生产镜像启动后访问 `http://localhost:30101`。

本地非 Docker 开发运行：
```bash
cp .env.example .env
go run .

# 另开一个终端窗口
cd web
bun install
bun run dev
```

本地源码构建运行：

```bash
cp .env.example .env
docker compose -f docker-compose.local.yml up -d --build
```

本地源码构建运行后默认端口 3000，可访问 `http://localhost:3000`

如需要拉取提示词，可前往:`http://localhost:3000/admin/prompts`

## 文档

- [功能介绍](docs/overview/features.md)
- [部署说明](docs/overview/docker.md)
- [画布节点操作手册](docs/canvas/canvas-node-manual.md)
- [画布快捷键](docs/canvas/canvas-shortcuts.md)
- [待办事项](docs/progress/todo.md)
- [后端数据库说明](docs/backend/backend-database.md)
- [系统配置数据结构](docs/backend/system-settings.md)
- [接口响应约定](docs/backend/api-response.md)

## 开源协议

本项目使用 MIT License，见 [LICENSE](LICENSE)。原项目版权归原作者所有，二次开发部分由当前维护者维护。
