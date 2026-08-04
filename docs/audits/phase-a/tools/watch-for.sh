#!/bin/bash
# Watch a measurement for change, with the baseline captured as the FIRST ACT.
#
# WHY THIS EXISTS: on 2026-08-04 I made the same measurement error five times in
# one day, published one of them to the operator, and retracted it. Ninety
# minutes after writing the rule against it into durable memory, I did it again
# — on the very outcome I was waiting for. I set a watcher for a 21:00:00Z
# event, took my "before" reading at 21:00:35Z, saw no change, and concluded the
# job had reported success without doing its work. The baseline was six seconds
# LATE. The row was already there.
#
# The rule ("capture the baseline before the event") did not work, because the
# rule is not present at the moment of arming — and taking the baseline "when I
# start watching" FEELS like taking it before the event. Those are different
# instants and they are indistinguishable from the inside.
#
# So: don't offer a right way to remember. Remove the opportunity.
#   - The baseline is this script's first act, before anything else.
#   - The baseline's own timestamp is always printed, so a late one is visible.
#   - --not-before makes lateness a REFUSAL rather than a silent wrong answer.
#
# Same lineage as jrnl.sh, which removed hand-typed timestamps for the same
# reason. A rule I re-read is still willpower.
#
# Usage:
#   watch-for.sh [--not-before <ISO8601>] [--timeout <sec>] [--interval <sec>] \
#                "<label>" "<shell command producing the measurement>"
#
# Exit: 0 changed · 1 unchanged (timeout) · 2 refused (baseline too late)
set -uo pipefail

NOT_BEFORE=""; TIMEOUT=600; INTERVAL=15
while [ $# -gt 0 ]; do
  case "$1" in
    --not-before) NOT_BEFORE="$2"; shift 2 ;;
    --timeout)    TIMEOUT="$2";    shift 2 ;;
    --interval)   INTERVAL="$2";   shift 2 ;;
    *) break ;;
  esac
done
[ $# -ge 2 ] || { echo "watch-for.sh: need <label> and <command>" >&2; exit 2; }
LABEL="$1"; CMD="$2"

# ---- FIRST ACT: baseline, and its real timestamp. Nothing precedes this. ----
BASE_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BASE=$(eval "$CMD" 2>&1)
BASE_EPOCH=$(date +%s)

echo "watch-for: $LABEL"
echo "  baseline AT : $BASE_TS   <- if this is after the event, the watch is invalid"
echo "  baseline    : $BASE"

# ---- The guarantee: a baseline taken after the event is a REFUSAL. ----
if [ -n "$NOT_BEFORE" ]; then
  # string compare is correct for zero-padded ISO-8601 UTC
  if [[ "$BASE_TS" > "$NOT_BEFORE" ]]; then
    echo "  REFUSED: baseline $BASE_TS is AFTER --not-before $NOT_BEFORE."
    echo "  The event may already have happened, so 'unchanged' would be meaningless."
    echo "  Re-arm before the event, or drop --not-before and read the result as inconclusive."
    exit 2
  fi
  echo "  not-before  : $NOT_BEFORE  (baseline precedes it — watch is valid)"
fi

DEADLINE=$(( BASE_EPOCH + TIMEOUT ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep "$INTERVAL"
  NOW=$(eval "$CMD" 2>&1)
  if [ "$NOW" != "$BASE" ]; then
    echo "  CHANGED at  : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "  now         : $NOW"
    exit 0
  fi
done

echo "  UNCHANGED through $(date -u +%Y-%m-%dT%H:%M:%SZ) (${TIMEOUT}s)"
echo "  This is a real negative ONLY because the baseline above predates the window."
exit 1
