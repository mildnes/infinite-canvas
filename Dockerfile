# 编译独立 ComfyUI Bridge 下载产物。
FROM golang:1.25-alpine AS bridge-build

WORKDIR /app/canvas-agent/native/comfy-bridge
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
COPY canvas-agent/native/comfy-bridge ./
RUN mkdir -p /bridge && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /bridge/InfiniteCanvas-ComfyBridge.exe . \
    && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o /bridge/InfiniteCanvas-ComfyBridge-linux-amd64 . \
    && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o /bridge/InfiniteCanvas-ComfyBridge-linux-arm64 .

# 构建 Next.js 前端产物。
FROM oven/bun:1.3.14 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
COPY shared /app/shared
COPY canvas-agent/scripts /app/canvas-agent/scripts
COPY --from=bridge-build /bridge/ /app/web/public/
ENV CANVAS_PREBUILT_BRIDGE=1
RUN bun run build

# 构建 Go 后端入口。
FROM golang:1.25-alpine AS api-build

WORKDIR /app
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
COPY go.mod go.sum ./
COPY config ./config
COPY cmd ./cmd
COPY handler ./handler
COPY middleware ./middleware
COPY model ./model
COPY repository ./repository
COPY router ./router
COPY service ./service
COPY shared ./shared
COPY main.go ./
RUN go build -o /server . && go build -o /media-cloud ./cmd/media-cloud && go build -o /media-verify ./cmd/media-verify && go build -o /media-previews ./cmd/media-previews && go build -o /media-gc ./cmd/media-gc && go build -o /image-log-summaries ./cmd/image-log-summaries && go build -o /canvas-media-repair ./cmd/canvas-media-repair

# 运行镜像：Next.js 对外监听 3000，Go 只在容器内部监听 8080。
FROM node:22-bookworm-slim

WORKDIR /app
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=api-build /server /app/server
COPY --from=api-build /media-cloud /app/media-cloud
COPY --from=api-build /media-verify /app/media-verify
COPY --from=api-build /media-previews /app/media-previews
COPY --from=api-build /media-gc /app/media-gc
COPY --from=api-build /image-log-summaries /app/image-log-summaries
COPY --from=api-build /canvas-media-repair /app/canvas-media-repair
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
COPY --from=web-build /app/web/public /app/web/public
COPY --from=web-build /app/web/.next/standalone /app/web
COPY --from=web-build /app/web/.next/static /app/web/.next/static
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV PROMPT_DATA_DIR=/app/data/prompts
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/data/prompts

EXPOSE 3000
# 先启动内部 Go API，再由 Next.js 提供页面并代理 /api/*。
CMD ["/app/docker-entrypoint.sh"]
