#!/usr/bin/env bash
# Loads .env (if present) and runs the uploader using the local venv.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${VENV:-$HERE/venv}"

if [ -f "$HERE/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERE/.env"
  set +a
fi

exec "$VENV/bin/python" "$HERE/monarch_receipt_uploader.py"
