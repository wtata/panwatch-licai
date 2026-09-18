# 基于官方 0.13.2 的 overlay 部署

运行中的 `sunxiao0721/panwatch:latest` 对应 **VERSION 0.13.2**（git tag `0.13.2` = `7a4de28`）。

**不要**把当前 `main` 的整棵 `src/` 拷进该容器。main 已包含 `pan_agent_token_meter` 等包，0.13.2 镜像里没有，启动会 `ModuleNotFoundError`。

本分支 `cursor/licai-on-0.13.2-2780` 从 tag `0.13.2` 拉出，只叠加理财看板的总览 / 纪律 / 学习。

## 推荐：overlay 构建（不替换整个 /app/src）

需要本机能拉取 Docker Hub 镜像 `sunxiao0721/panwatch:0.13.2`。

```bash
git checkout cursor/licai-on-0.13.2-2780
docker build -f Dockerfile.overlay -t panwatch-licai:0.13.2-overlay .
```

`Dockerfile.overlay` 会：

1. 用本分支前端源码 `pnpm build`
2. `FROM sunxiao0721/panwatch:0.13.2`
3. 只 COPY：
   - `src/modules/licai`
   - `src/bootstrap/application.py`
   - `src/platform/persistence/models.py`
   - `src/platform/persistence/migrations.py`
   - 构建好的静态资源到 `/app/static`

## 替换本机容器（保留数据卷）

```bash
docker stop panwatch
docker rm panwatch

docker run -d \
  --name panwatch \
  -p 8000:8000 \
  -v panwatch_data:/app/data \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  panwatch-licai:0.13.2-overlay
```

`-v panwatch_data:/app/data` 必须与旧容器一致。不要 `docker volume rm panwatch_data`。

## 完整从源码构建

仓库根 `Dockerfile` 会从 `python:3.11-slim` 重装全部依赖（含 git 拉 TradingAgents），**需要 Docker Hub / 外网**，且应在本 0.13.2 分支上构建，不要在超前的 main 上构建再盖到 0.13.2 数据卷对应的运行时。

```bash
docker build -t panwatch-licai:local .
```

## 验证

1. `http://localhost:8000` 用原账号登录
2. 导航出现 **总览 / 纪律 / 学习**
3. 持仓数字与替换前一致
4. `/docs` 中有 `/api/discipline/*`、`/api/learning/cards`

## 与 main 的关系

合入最新 main 的代码改动见另一条 PR（基于当前 main）。本分支只服务「正在跑 0.13.2 镜像」的 overlay，请勿 squash merge 到 main（会倒退 #112 之后的提交）。
