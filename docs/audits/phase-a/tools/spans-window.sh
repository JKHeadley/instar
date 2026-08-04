#!/bin/bash
# Assert that a CORPUS actually covers the WINDOW a claim is about.
#
# WHY THIS EXISTS: the sibling guard (watch-for.sh) closes one half of this
# window's most expensive error class — a baseline taken too LATE. This closes
# the other half: a corpus that does not SPAN the window the claim describes.
#
# Measured 2026-08-04, four instances in one day:
#   - "codex is still returning 401s"  — the metric window straddled an outage
#     that had already been fixed; every 401 predated the fix.
#   - "zero jobs completed in 90 minutes" — read off a route that exposes no
#     last-run field at all, so the corpus could not answer the question.
#   - a claim about 03:49Z checked against a job history that begins at 09:00Z.
#     I caught that one by hand and wrote "my window doesn't reach back to when
#     that item was raised" — which is exactly what this automates.
#   - the same shape again on a 400-row cap that silently truncates the tail.
#
# The failure mode is that a too-short corpus returns a confident, well-formed,
# EMPTY answer. "No 401s before the fix" and "my log doesn't go back that far"
# render identically. This makes the second one a refusal.
#
# Usage:
#   spans-window.sh --from <ISO8601> [--to <ISO8601>] "<label>" "<command>"
#     <command> must emit timestamps on stdout (one per line, or embedded —
#     the first ISO-8601-looking token per line is used).
#
# Exit: 0 corpus spans the window · 1 corpus is EMPTY · 2 corpus does not span it
set -uo pipefail

FROM=""; TO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --to)   TO="$2";   shift 2 ;;
    *) break ;;
  esac
done
[ -n "$FROM" ] || { echo "spans-window.sh: --from is required" >&2; exit 2; }
[ $# -ge 2 ] || { echo "spans-window.sh: need <label> and <command>" >&2; exit 2; }
LABEL="$1"; CMD="$2"

TS=$(eval "$CMD" 2>/dev/null \
     | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' \
     | sort)
COUNT=$(printf '%s\n' "$TS" | grep -c . || true)

echo "spans-window: $LABEL"
echo "  claim window : $FROM  ->  $TO"

if [ "$COUNT" -eq 0 ]; then
  echo "  corpus       : EMPTY — no parseable timestamps"
  echo "  VERDICT: cannot answer. An empty corpus is not evidence of absence."
  exit 1
fi

MIN=$(printf '%s\n' "$TS" | head -1)
MAX=$(printf '%s\n' "$TS" | tail -1)
echo "  corpus       : $COUNT rows, $MIN -> $MAX"

OK=1
if [[ "$MIN" > "$FROM" ]]; then
  echo "  ✗ corpus STARTS AFTER the window opens — everything before $MIN is unobserved"
  OK=0
fi
if [[ "$MAX" < "$TO" ]]; then
  echo "  ✗ corpus ENDS BEFORE the window closes — everything after $MAX is unobserved"
  OK=0
fi

if [ "$OK" -eq 1 ]; then
  echo "  VERDICT: SPANS the window. A negative result here is a real negative."
  exit 0
fi
echo "  VERDICT: DOES NOT SPAN. Any 'nothing found' is unsupported — widen the corpus"
echo "           or narrow the claim to $MIN -> $MAX, which is what was actually observed."
exit 2
