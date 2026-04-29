#!/usr/bin/env bash
# server-deploy.sh — run this ON the server (via ssh or directly)
# Usage: bash scripts/server-deploy.sh [--full]
#
# --full  also runs pnpm install (use when package.json changed)
#
# One-time server setup:
#   git clone <repo-url> /path/to/scriptorium
#   cd /path/to/scriptorium
#   pnpm install
#   cp spreadsheet-api/.env.example spreadsheet-api/.env && nano spreadsheet-api/.env
#   cp yjs-server/.env.example yjs-server/.env && nano yjs-server/.env  # if applicable
#   pm2 start pm2.config.cjs
#   pm2 save

set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ Pulling latest code..."
git pull --ff-only

if [[ "${1:-}" == "--full" ]]; then
    echo "→ Installing dependencies..."
    pnpm install --frozen-lockfile
fi

echo "→ Reloading servers..."
pm2 reload pm2.config.cjs --update-env

echo "✓ Deploy complete"
pm2 ls
