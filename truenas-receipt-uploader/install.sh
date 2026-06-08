#!/usr/bin/env bash
# Creates a Python virtualenv next to this script and installs dependencies.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${VENV:-$HERE/venv}"

echo ">> Creating virtualenv at $VENV"
python3 -m venv "$VENV"

echo ">> Upgrading pip"
"$VENV/bin/pip" install --upgrade pip

echo ">> Installing dependencies (this pulls the library from the PR branch)"
"$VENV/bin/pip" install -r "$HERE/requirements.txt"

echo
echo "Done."
echo "Next:"
echo "  1) cp .env.example .env   &&   edit .env   (then: chmod 600 .env)"
echo "  2) ./run.sh               (first run is interactive: clears MFA, saves session)"
