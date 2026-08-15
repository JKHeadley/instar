#!/usr/bin/env bash
# run-f2-abs.sh — batched A/B for the 8 wave-2 F2 authority-clause variants.
# RUN ONLY AFTER the paced wave-2 lane (gemini+groq) has FINISHED — this A/Bs on
# the gemini door, which would contend with the live paced lane.
#
# Each variant is A/B'd against its tasks-wave2 incumbent across the 4 CLI doors
# (claude, codex, pi, gemini; groq skipped — slowest/throttled, rarely the
# F2-failing door). Generous per-variant timeout (codex ~15s/call) so no arm is
# cut off mid-run (the 300s-cap mistake from the first piecemeal attempt).
# Ratchet: CLEAN-WIN = ≥1 fixed cell, 0 regressions → auto-ship (non-critical).
set -uo pipefail
cd "$(dirname "$0")"
DOORS="${F2_DOORS:-claude-code,codex,pi,gemini}"
LOG=../results/instar-bench-v2/f2-ab-driver.log
: > "$LOG"
VARIANTS=(
  presence-tier3-stall
  telegram-stall-confirm
  arc-check-classify
  task-classifier
  override-detector
  session-summary-sentinel
  resume-sanity-check
  resume-validator
)
for v in "${VARIANTS[@]}"; do
  echo "=== A/B $v ($(date -u +%H:%M:%S)) ===" | tee -a "$LOG"
  # presence-tier3-stall uses the gentler authority-only v2 (v1 regressed a
  # 'waiting' case on the claude door via its stalled-steering sentence).
  # presence + arc-check use gentler authority-only v2 (v1 bundled task steering
  # that regressed canon cases on the claude door). Pure-authority clauses win.
  variant="variants-wave2/$v.f2-authority.json"
  case "$v" in presence-tier3-stall|arc-check-classify) variant="variants-wave2/$v.f2-authority-v2.json";; esac
  timeout 1500 node ab-run.mjs \
    --task "$v" \
    --variant "$variant" \
    --base-taskdir tasks-wave2 \
    --stamp "abf2b-$v" \
    --samples 1 \
    --routes-filter "$DOORS" 2>&1 | tail -3 | tee -a "$LOG"
done
echo "=== ALL F2 A/Bs DONE ($(date -u +%H:%M:%S)) ===" | tee -a "$LOG"
# Summary of rulings:
for v in "${VARIANTS[@]}"; do
  f=../results/instar-bench-v2/abf2b-$v-verdict.json
  [ -f "$f" ] && node -e "const d=require('$f');console.log('$v:',d.ruling,'fixed',d.fixed.length,'regressed',d.regressed.length)" | tee -a "$LOG"
done
