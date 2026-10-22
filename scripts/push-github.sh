#!/usr/bin/env bash
# 把 Gitea 主仓当前开发分支镜像上传到 GitHub main：GitHub 只作上传，不维护。
# 上传前剔除 Gitea 专用 CI、定价产出物和私有镜像域名，并重写可达历史。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${BRANCH:-feat/grok2api-protocol}"
UPSTREAM="${UPSTREAM:-origin}"
GITHUB_URL="${GITHUB_URL:-https://github.com/mildnes/infinite-canvas.git}"
SOURCE_REPO="${SOURCE_REPO:-}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/infinite-canvas-github.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

if ! command -v git-filter-repo >/dev/null; then
  echo "缺少 git-filter-repo，请先执行：brew install git-filter-repo" >&2
  exit 1
fi

echo "同步 $UPSTREAM/$BRANCH -> GitHub main"
SOURCE_REPO="${SOURCE_REPO:-$(git -C "$REPO_DIR" remote get-url "$UPSTREAM")}"
git clone --quiet --single-branch --no-tags --branch "$BRANCH" "$SOURCE_REPO" "$WORK_DIR/repo"
cd "$WORK_DIR/repo"

# GitHub 副本删除 .gitea/ 和 outputs/，把私有镜像域名换成占位符；
# 同步改写 docs 里指向已删除工作流文件的句子，避免 GitHub 上出现失效路径。
git filter-repo --force \
  --filename-callback 'return None if filename.startswith(b".gitea/") or filename.startswith(b"outputs/") else filename' \
  --blob-callback '
data = blob.data
if b"registry.example.com" in data:
    data = data.replace(b"registry.example.com:4443", b"registry.example.com:4443").replace(b"registry.example.com", b"registry.example.com")
if b".gitea/" in data:
    data = data.replace("镜像发布工作流位于 Gitea 仓库的 Actions 配置".encode(), "镜像发布工作流位于 Gitea 仓库的 Actions 配置".encode())
    data = data.replace("生产更新由 Gitea 仓库的部署工作流手动触发".encode(), "生产更新由 Gitea 仓库的部署工作流手动触发".encode())
if data != blob.data:
    blob.data = data
'

# 历史是重写过的，与 Gitea 分支永久分叉；用远端当前 SHA 作租约，避免覆盖他人在 GitHub 上的推送。
GITHUB_MAIN_SHA="$(git ls-remote "$GITHUB_URL" refs/heads/main | cut -f1 || true)"
if [ -n "$GITHUB_MAIN_SHA" ]; then
  git push --force-with-lease="refs/heads/main:$GITHUB_MAIN_SHA" "$GITHUB_URL" "HEAD:refs/heads/main"
else
  git push "$GITHUB_URL" "HEAD:refs/heads/main"
fi

echo "GitHub main 已更新为 $(git rev-parse --short HEAD)"
