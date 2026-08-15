#!/bin/bash
# Sequential A/B driver — one task at a time so door pacing is respected.
set -u
ROUTES="claude-code,codex-cli,pi-cli,gemini-cli,groq"
LOG=../results/instar-bench-v2/ab-driver.log
run_ab() {
  local task="$1" variant="$2" samples="$3"
  echo "[ab-driver] $(date '+%H:%M:%S') START $task ($variant, samples=$samples)" >> "$LOG"
  node ab-run.mjs --task "$task" --variant "variants/$variant" --stamp "ab-$task" \
    --samples "$samples" --routes-filter "$ROUTES" >> "$LOG" 2>&1
  echo "[ab-driver] $(date '+%H:%M:%S') END $task (exit $?)" >> "$LOG"
}
run_ab tone-gate tone-gate.rule-id-contract.json 1
run_ab completion-judge completion-judge.claim-not-evidence.json 1
run_ab external-op-gate external-op-gate.authority-and-degenerate.json 1
run_ab p13-stop-judge p13-stop-judge.no-stop-and-clock.json 1
run_ab input-classifier input-classifier.unsure-defined.json 1
run_ab sentinel-classify sentinel-classify.degenerate-normal.json 1
echo "[ab-driver] $(date '+%H:%M:%S') ALL DONE" >> "$LOG"
