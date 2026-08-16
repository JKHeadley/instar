#!/usr/bin/env bash
# run-v1-scenarios.sh — thin entry wrapping the Python driver.
# Real logic lives in run-v1-scenarios.py.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$HERE/run-v1-scenarios.py" "$@"
