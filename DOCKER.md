# 私有镜像构建与替换

本 fork 把理财看板的总览 / 纪律 / 学习并进 PanWatch。日常仍用同一份 SQLite 数据卷，不要删 `panwatch_data`。

数据目录在容器内是 `/app/data`（默认 `panwatch.db`）。重建容器时只要继续挂载**同一个 named volume**，持仓、设置、纪律笔记都会保留。

## 构建本地镜像

在仓库根目录：

```bash
docker build -t panwatch-licai:local .
```

指定版本号（写入镜像内 `VERSION` 文件）：

```bash
docker build --build-arg VERSION=licai-local -t panwatch-licai:local .
```

也可用仓库自带脚本（会打官方风格 tag；本地替换时仍建议再 tag 一份 `panwatch-licai:local`）：

```bash
./build.sh licai-local
docker tag panwatch:licai-local panwatch-licai:local
```

## 用本地镜像替换正在跑的官方容器

假设当前是官方 README 的标准形态：

```bash
docker run -d \
  --name panwatch \
  -p 8000:8000 \
  -v panwatch_data:/app/data \
  sunxiao0721/panwatch:latest
```

按下面顺序**只删容器、不删卷**：

```bash
docker stop panwatch
docker rm panwatch

docker run -d \
  --name panwatch \
  -p 8000:8000 \
  -v panwatch_data:/app/data \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  panwatch-licai:local
```

关键点：

- `-v panwatch_data:/app/data` 必须与旧容器一致，否则会连到空库
- 不要 `docker volume rm panwatch_data`
- 不要 `docker run` 时换成匿名卷或绑定到空目录
- 首次启动若未设 `PLAYWRIGHT_SKIP_BROWSER_INSTALL=1`，仍可能下载 Chromium

## Docker Compose

把 `image` 换成本地 tag，**volumes 名称保持不变**：

```yaml
services:
  panwatch:
    image: panwatch-licai:local
    container_name: panwatch
    ports:
      - "8000:8000"
    volumes:
      - panwatch_data:/app/data
    restart: unless-stopped
    environment:
      TZ: Asia/Shanghai

volumes:
  panwatch_data:
```

```bash
docker compose up -d
```

Compose 会重建容器并继续使用已有 `panwatch_data`。

## 验证

1. 打开 `http://localhost:8000`，用原来的账号登录（JWT 仍在库里）
2. 导航应出现 **总览 / 纪律 / 学习**
3. 持仓数字应与替换前一致
4. Swagger：`http://localhost:8000/docs`，确认 `/api/discipline/*`、`/api/learning/cards` 存在且未登录返回 401（已初始化密码时）

回退官方镜像时同样只换 `image`，继续挂载 `panwatch_data`。
