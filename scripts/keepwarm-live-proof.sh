#!/usr/bin/env bash
set -euo pipefail
exec python3 -I -B "$(dirname "$0")/keepwarm-live-proof.py" "$@"
