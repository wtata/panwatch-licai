# PanWatch Dockerfile
# 多阶段构建，减小最终镜像大小

# ===== Stage 1: 前端构建 =====
FROM node:24.14.0-alpine AS frontend-builder

WORKDIR /app/frontend

# 启用并固定 pnpm，避免镜像构建时随 npm 全局安装漂移
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# 复制依赖文件
COPY frontend/package.json frontend/pnpm-lock.yaml ./

# 安装依赖
RUN pnpm install --frozen-lockfile

# 复制源码并构建
COPY frontend/ ./
# 版本号以仓库根目录 VERSION 为准；发布流水线可用 --build-arg VERSION 覆盖。
ARG VERSION=
COPY VERSION /tmp/VERSION
RUN set -eu; \
    if [ -n "${VERSION}" ]; then \
      v="${VERSION#v}"; \
      case "$v" in \
        [0-9]*.[0-9]*.[0-9]*) printf '%s\n' "$v" > /tmp/VERSION ;; \
      esac; \
    fi; \
    node -e 'const fs=require("fs"); const v=fs.readFileSync("/tmp/VERSION","utf8").trim(); if(!/^\d+\.\d+\.\d+$/.test(v)){console.error("invalid VERSION:", v); process.exit(1);} const p=JSON.parse(fs.readFileSync("package.json","utf8")); p.version=v; fs.writeFileSync("package.json", JSON.stringify(p,null,2)+"\n");'
RUN pnpm build


# ===== Stage 2: Python 运行环境 =====
FROM python:3.11-slim

WORKDIR /app

# 安装系统依赖
# - tzdata: 时区数据（zoneinfo 模块需要）
# - 中文字体（K线截图需要）
# - Playwright Chromium 依赖的系统库
RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    # git: requirements.txt 中含 git+https 直链(tradingagents)
    git \
    # 中文字体
    fonts-noto-cjk \
    # Playwright Chromium 依赖
    # (这些库缺失会导致 playwright 提示 Host system is missing dependencies)
    libxcursor1 \
    libgtk-3-0 \
    libpangocairo-1.0-0 \
    libcairo-gobject2 \
    libgdk-pixbuf-2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    # 常见的 Chromium 运行时依赖（不同版本/发行版可能会缺）
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxext6 \
    libxi6 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libxshmfence1 \
    libegl1 \
    libfontconfig1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -fv

# 复制依赖文件
COPY requirements.txt ./

# 复制本仓内本地包(requirements.txt 里 -e ./packages/marketdata 需要它先在)
COPY packages/ ./packages/

# 安装 Python 依赖
RUN pip install --no-cache-dir -r requirements.txt

# 注意: Playwright 浏览器将在首次启动时自动安装到 data 目录
# 这样可以减小镜像体积，并支持跨版本持久化

# 复制后端代码
COPY src/ ./src/
COPY server.py ./
COPY prompts/ ./prompts/

# 版本号唯一来源是仓库根目录 VERSION。--build-arg VERSION 仅在发布时覆盖文件内容。
ARG VERSION=
COPY VERSION ./VERSION
RUN if [ -n "${VERSION}" ]; then \
      v="${VERSION#v}"; \
      case "$v" in \
        [0-9]*.[0-9]*.[0-9]*) printf '%s\n' "$v" > VERSION ;; \
      esac; \
    fi

# 从前端构建阶段复制静态文件
COPY --from=frontend-builder /app/frontend/dist ./static/

# 创建数据目录和日志目录（日志可挂载到宿主机）
RUN mkdir -p /app/data /app/logs

# 环境变量
ENV PYTHONUNBUFFERED=1
ENV DATA_DIR=/app/data
ENV LOG_DIR=/app/logs
ENV DOCKER=1

# 默认时区（可在 docker run 时用 -e TZ=... 覆盖）
ENV TZ=Asia/Shanghai

# 暴露端口（保持 8000 不变，避免影响存量用户升级）
EXPOSE 8000

# 健康检查（使用 Python）
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# 启动命令
CMD ["python", "server.py"]
