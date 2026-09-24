#!/usr/bin/env bash
# 股视盯部署脚本。工具箱一键重新部署只调用这一条命令。
# 本脚本只负责在目标机器上同步代码、构建镜像并重建容器，不会删除数据卷。
#
# 用法：
#   ./deploy.sh              # 默认：整镜像重建并替换同名容器
#   ./deploy.sh incremental  # 增量：把 src、server.py、VERSION 拷进已有容器后重启
#
# 在开发机上调用、到服务器上执行时，设置 SSH 相关变量。脚本里不写地址、用户和密钥。
# 未设置 DEPLOY_SSH_HOST 时，认为当前机器就是部署机，直接操作本机 Docker。
#
# 环境变量：
#   DEPLOY_SSH_HOST       可选。远程主机名或地址。留空则在本机执行。
#   DEPLOY_SSH_USER       DEPLOY_SSH_HOST 有值时必填。
#   DEPLOY_SSH_KEY        可选。私钥文件路径。不设则使用 ssh-agent 或默认密钥。
#   DEPLOY_SSH_PORT       可选。默认 22。
#   DEPLOY_REPO_DIR       服务器上的仓库目录。默认 /opt/panwatch。
#   GIT_REMOTE            可选。默认 origin。
#   GIT_REF               可选。要拉取的分支或标签。默认当前分支。
#   PANWATCH_IMAGE        镜像名。默认 panwatch:local。
#   PANWATCH_CONTAINER    容器名。默认 panwatch。
#   PANWATCH_PORT         宿主机端口，映射到容器 8000。默认 8000。
#   PANWATCH_DATA_VOLUME  数据卷名，挂到容器 /app/data。默认 panwatch_data。
#   PANWATCH_LOG_DIR      宿主机日志目录，挂到容器 /app/logs。
#                         默认 ${DEPLOY_REPO_DIR}/logs。
#   PANWATCH_ENV_FILE     可选。传给 docker run --env-file 的文件，放账号和初始密码。
#                         该文件不要提交到 Git。未设置时，重建容器会从旧容器抄一份
#                         运行所需的环境变量，避免把已经改过的配置弄丢。
#
# 示例（值请换成你自己的，不要写进仓库）：
#   export DEPLOY_SSH_HOST=your-server
#   export DEPLOY_SSH_USER=your-user
#   export DEPLOY_SSH_KEY=/path/to/key
#   export DEPLOY_REPO_DIR=/opt/panwatch
#   ./deploy.sh

set -euo pipefail

MODE="${1:-rebuild}"
if [[ "$MODE" != "rebuild" && "$MODE" != "incremental" ]]; then
  echo "用法: $0 [rebuild|incremental]" >&2
  exit 2
fi

DEPLOY_REPO_DIR="${DEPLOY_REPO_DIR:-/opt/panwatch}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
PANWATCH_IMAGE="${PANWATCH_IMAGE:-panwatch:local}"
PANWATCH_CONTAINER="${PANWATCH_CONTAINER:-panwatch}"
PANWATCH_PORT="${PANWATCH_PORT:-8000}"
PANWATCH_DATA_VOLUME="${PANWATCH_DATA_VOLUME:-panwatch_data}"
PANWATCH_LOG_DIR="${PANWATCH_LOG_DIR:-${DEPLOY_REPO_DIR}/logs}"

run_remote() {
  : "${DEPLOY_SSH_USER:?设置了 DEPLOY_SSH_HOST 时必须同时设置 DEPLOY_SSH_USER}"
  local ssh_opts=(-o StrictHostKeyChecking=accept-new -p "${DEPLOY_SSH_PORT:-22}")
  if [[ -n "${DEPLOY_SSH_KEY:-}" ]]; then
    ssh_opts+=(-i "$DEPLOY_SSH_KEY")
  fi
  # 远程重新执行本脚本，并清掉 DEPLOY_SSH_HOST，避免循环 SSH。
  ssh "${ssh_opts[@]}" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" \
    "export DEPLOY_SSH_HOST= DEPLOY_REPO_DIR='${DEPLOY_REPO_DIR}' GIT_REMOTE='${GIT_REMOTE}' GIT_REF='${GIT_REF:-}' PANWATCH_IMAGE='${PANWATCH_IMAGE}' PANWATCH_CONTAINER='${PANWATCH_CONTAINER}' PANWATCH_PORT='${PANWATCH_PORT}' PANWATCH_DATA_VOLUME='${PANWATCH_DATA_VOLUME}' PANWATCH_LOG_DIR='${PANWATCH_LOG_DIR}' PANWATCH_ENV_FILE='${PANWATCH_ENV_FILE:-}'; cd '${DEPLOY_REPO_DIR}' && bash ./deploy.sh '${MODE}'"
}

if [[ -n "${DEPLOY_SSH_HOST:-}" ]]; then
  run_remote
  exit 0
fi

cd "$DEPLOY_REPO_DIR"

if [[ ! -d .git ]]; then
  echo "DEPLOY_REPO_DIR 不是 git 仓库: ${DEPLOY_REPO_DIR}" >&2
  exit 1
fi

echo "同步代码: ${GIT_REMOTE} ${GIT_REF:-（当前分支）}"
git fetch "$GIT_REMOTE"
if [[ -n "${GIT_REF:-}" ]]; then
  git checkout "$GIT_REF"
  git pull --ff-only "$GIT_REMOTE" "$GIT_REF"
else
  git pull --ff-only "$GIT_REMOTE"
fi

fetch_health() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$url" 2>/dev/null || true
    return
  fi
  python3 -c 'import sys, urllib.request; print(urllib.request.urlopen(sys.argv[1], timeout=5).read().decode())' "$url" 2>/dev/null || true
}

wait_for_health() {
  local url="http://127.0.0.1:${PANWATCH_PORT}/health"
  local attempt payload
  for attempt in $(seq 1 30); do
    payload="$(fetch_health "$url")"
    if [[ "$payload" == *'"status":"ok"'* || "$payload" == *'"status": "ok"'* ]]; then
      echo "健康检查通过: ${url}"
      printf '%s\n' "$payload"
      return 0
    fi
    sleep 2
  done
  echo "健康检查失败: ${url}" >&2
  return 1
}

if [[ "$MODE" == "incremental" ]]; then
  if ! docker inspect "$PANWATCH_CONTAINER" >/dev/null 2>&1; then
    echo "增量模式需要已存在的容器 ${PANWATCH_CONTAINER}。请先执行 ./deploy.sh" >&2
    exit 1
  fi
  docker cp src/. "${PANWATCH_CONTAINER}:/app/src/"
  docker cp server.py "${PANWATCH_CONTAINER}:/app/server.py"
  docker cp VERSION "${PANWATCH_CONTAINER}:/app/VERSION"
  if [[ -d static ]]; then
    docker cp static/. "${PANWATCH_CONTAINER}:/app/static/"
  fi
  docker restart "$PANWATCH_CONTAINER" >/dev/null
  wait_for_health
  exit 0
fi

version="$(tr -d '[:space:]' < VERSION)"
echo "构建镜像 ${PANWATCH_IMAGE}（VERSION=${version}）"
docker build -t "$PANWATCH_IMAGE" --build-arg "VERSION=${version}" .

mkdir -p "$PANWATCH_LOG_DIR"

env_file="${PANWATCH_ENV_FILE:-}"
cleanup_env=""
if [[ -z "$env_file" ]] && docker inspect "$PANWATCH_CONTAINER" >/dev/null 2>&1; then
  env_file="$(mktemp)"
  cleanup_env="$env_file"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$PANWATCH_CONTAINER" \
    | grep -E '^(AUTH_USERNAME|AUTH_PASSWORD|JWT_SECRET|TZ|DATA_DIR|PLAYWRIGHT_SKIP_BROWSER_INSTALL|HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy|NO_PROXY|OTEL_EXPORTER_OTLP_ENDPOINT|OTEL_SERVICE_NAME|LOG_LEVEL|LOG_RETENTION_DAYS|PANWATCH_BASE_URL)=' \
    > "$env_file" || true
  chmod 600 "$env_file"
fi

docker rm -f "$PANWATCH_CONTAINER" >/dev/null 2>&1 || true

run_args=(
  -d
  --name "$PANWATCH_CONTAINER"
  --restart unless-stopped
  -p "${PANWATCH_PORT}:8000"
  -v "${PANWATCH_DATA_VOLUME}:/app/data"
  -v "${PANWATCH_LOG_DIR}:/app/logs"
  -e LOG_DIR=/app/logs
)
if [[ -n "$env_file" && -s "$env_file" ]]; then
  run_args+=(--env-file "$env_file")
fi
run_args+=("$PANWATCH_IMAGE")

docker run "${run_args[@]}" >/dev/null
if [[ -n "$cleanup_env" ]]; then
  rm -f "$cleanup_env"
fi

wait_for_health
