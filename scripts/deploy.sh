#!/usr/bin/env bash
# deploy.sh — run locally to deploy everything to the server
#
# Usage:
#   pnpm deploy           # frontend + reload servers
#   pnpm deploy:full      # frontend + pnpm install on server + reload servers
#   pnpm deploy:frontend  # frontend only (no server restart)
#   pnpm deploy:servers   # server reload only (no frontend build)
#
# Configure these:
SERVER_USER="${DEPLOY_USER:-jon}"
SERVER_HOST="${DEPLOY_HOST:-instrumenta.cf}"
SERVER_REPO_PATH="${DEPLOY_REPO_PATH:-/var/www/plainTab}"
WEBROOT="${DEPLOY_WEBROOT:-/var/www/html}"

set -euo pipefail

MODE="${1:-all}"

deploy_frontend() {
    echo "→ Building frontend..."
    pnpm build
    echo "→ Syncing dist/ to ${SERVER_HOST}:${WEBROOT}/"
    rsync -az --delete dist/ "${SERVER_USER}@${SERVER_HOST}:${WEBROOT}/"
    echo "✓ Frontend deployed"
}

deploy_servers() {
    local extra="${1:-}"
    echo "→ Deploying servers on ${SERVER_HOST}..."
    ssh "${SERVER_USER}@${SERVER_HOST}" "bash ${SERVER_REPO_PATH}/scripts/server-deploy.sh ${extra}"
}

case "$MODE" in
    all)          deploy_frontend; deploy_servers ;;
    full)         deploy_frontend; deploy_servers --full ;;
    frontend)     deploy_frontend ;;
    servers)      deploy_servers ;;
    servers:full) deploy_servers --full ;;
    *) echo "Unknown mode: $MODE"; exit 1 ;;
esac
