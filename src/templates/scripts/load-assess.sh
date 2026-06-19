#!/usr/bin/env bash
# load-assess.sh — the DURABLE go-to method for evaluating machine load.
#
# WHY THIS EXISTS: `uptime` 1-minute load average is the WRONG signal for "can I
# do work / is the machine genuinely loaded." It is (a) spike-susceptible (the
# 1-min figure swings wildly) and (b) on macOS INFLATED by threads stuck in
# uninterruptible disk I/O (e.g. Spotlight/mds reindex after a cold boot) — so a
# high load average can coexist with a mostly-idle CPU. On 2026-06-19 a load avg
# of ~40 was quoted as "heavy load" when the CPU was actually 62% IDLE and the
# load was Spotlight reindexing, not the agent. Never repeat that.
#
# THIS reports the RIGHT signals: real CPU idle% (sampled, not instantaneous),
# instar's time-windowed ResourceLedger (agent-attributed CPU avg/peak over the
# last hour), per-core load normalization, and WHAT is consuming CPU (so you can
# tell "my work" from external/transient like Spotlight). Then it emits a verdict.
#
# SCOPE HONESTY: the verdict is a CPU-CAPACITY signal. It does NOT assess
# memory/swap, thermal throttling, or disk-I/O saturation — OK means "CPU has
# headroom," not "everything is fine." Memory/pressure is covered separately by
# the ResourceLedger / reaper-pressure surfaces.
#
# Usage: load-assess.sh            (human-readable verdict)
#        load-assess.sh --json     (machine-readable; human-diagnostic only,
#                                    unversioned — a programmatic consumer must
#                                    add a schemaVersion first, not assume shape)
set -uo pipefail
cd "$(dirname "$0")/../.." 2>/dev/null || true   # agent home (.instar/scripts -> home)

JSON=0; [ "${1:-}" = "--json" ] && JSON=1
OS=$(uname -s 2>/dev/null || echo unknown)

# --- cores ---
if [ "$OS" = "Darwin" ]; then CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo 0)
else CORES=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 0); fi

# --- real CPU idle%: sampled (NOT a single instantaneous read) ---
IDLE=""
if [ "$OS" = "Darwin" ]; then
  # macOS: top -l 2, SECOND sample is the real one (first is bogus)
  CPU_LINE=$(top -l 2 -n 0 -s 1 2>/dev/null | grep "CPU usage" | tail -1)
  IDLE=$(echo "$CPU_LINE" | sed -n 's/.*[, ]\([0-9.]*\)% idle.*/\1/p')
elif [ -r /proc/stat ]; then
  # Linux: TWO-SAMPLE /proc/stat delta. A single read CANNOT compute idle%.
  read_stat() { awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++)tot+=$i; print idle, tot}' /proc/stat; }
  S1=$(read_stat); sleep 1; S2=$(read_stat)
  IDLE=$(awk -v a="$S1" -v b="$S2" 'BEGIN{
    split(a,x," "); split(b,y," ");
    di=y[1]-x[1]; dt=y[2]-x[2];
    if(dt>0) printf "%.1f", 100*di/dt; else print "";
  }')
fi
[ -z "$IDLE" ] && IDLE=""   # empty => CPU read unavailable (e.g. unknown OS / no top)
# Test-only seam: force the sampled idle% so the verdict-threshold boundaries can be
# exercised deterministically (the real CPU read is environment-dependent). Read-only,
# affects only the printed verdict; never set in production.
[ -n "${LOAD_ASSESS_FORCE_IDLE:-}" ] && IDLE="$LOAD_ASSESS_FORCE_IDLE"
if [ -n "$IDLE" ]; then BUSY=$(awk -v i="$IDLE" 'BEGIN{printf "%.1f", 100-i}'); else BUSY=""; fi

# --- load averages (CONTEXT ONLY — never the basis of the verdict) ---
LOADS=$(uptime 2>/dev/null | sed -n 's/.*load average[s]*: *//p')
L1=$(echo "$LOADS" | awk -F'[ ,]+' '{print $1}')
L5=$(echo "$LOADS" | awk -F'[ ,]+' '{print $2}')
LOAD_PER_CORE=$(awk -v l="${L5:-0}" -v c="${CORES:-0}" 'BEGIN{if(c+0>0)printf "%.2f", l/c; else print "?"}')

# --- instar ResourceLedger: time-windowed agent-attributed CPU (the durable signal) ---
LEDGER="unavailable"
AUTH=$(node .instar/scripts/secret-get.mjs authToken 2>/dev/null || echo "")
PORT=$(node -pe "require('./.instar/config.json').port" 2>/dev/null || echo 4042)
AGENT_ID="${INSTAR_AGENT_ID:-$(node -pe "require('./.instar/config.json').projectName" 2>/dev/null || echo "")}"
if [ -n "$AUTH" ]; then
  LEDGER=$(curl -s -m 8 -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: ${AGENT_ID}" "http://localhost:${PORT}/resources/summary?sinceHours=1" 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const a=(j.sources||[]).find(s=>s.source==='aggregate')||{};console.log('avg='+(a.avgCpuPercent??'?')+' peak='+(a.peakCpuPercent??'?')+' current='+(a.currentCpuPercent??'?')+' samples='+(j.sampleCount??'?'))}catch(e){console.log('unavailable')}})" 2>/dev/null || echo "unavailable")
fi

# --- top CPU consumers + classify my-work vs external ---
TOP=$(ps -Ao pcpu,comm -r 2>/dev/null | sed -n '2,4p')
TOP1=$(echo "$TOP" | head -1 | awk '{print $2}')
EXTERNAL="unknown"
case "$TOP1" in
  *mds*|*mdworker*|*Spotlight*|*WindowServer*|*backupd*|*photoanalysisd*|*mediaanalysisd*) EXTERNAL="external-transient (macOS: $(basename "$TOP1" 2>/dev/null))";;
  *instar*|*node*|*claude*|*tmux*|*python*) EXTERNAL="agent-work ($(basename "$TOP1" 2>/dev/null))";;
  "") EXTERNAL="unknown";;
  *) EXTERNAL="other ($(basename "$TOP1" 2>/dev/null))";;
esac

# --- VERDICT (based on real idle%, NOT load average) ---
awk_lt() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a+0<b+0)}'; }
if [ -z "$IDLE" ]; then
  VERDICT="UNKNOWN"; REASON="CPU idle% unavailable on this platform; rely on the agent CPU ledger + load context"
elif awk_lt "$IDLE" 12; then VERDICT="SATURATED"; REASON="CPU genuinely saturated (idle <12%)";
elif awk_lt "$IDLE" 30; then VERDICT="ELEVATED"; REASON="CPU busy but not saturated";
else VERDICT="OK"; REASON="CPU mostly idle"; fi

if [ "$JSON" = "1" ]; then
  printf '{"verdict":"%s","reason":"%s","cpuIdlePercent":%s,"cpuBusyPercent":%s,"cores":%s,"loadAvg1":"%s","loadAvg5":"%s","loadPerCore":"%s","ledger":"%s","topConsumer":"%s","topClass":"%s","scope":"cpu-capacity-only","os":"%s"}\n' \
    "$VERDICT" "$REASON" "${IDLE:-null}" "${BUSY:-null}" "${CORES:-0}" "${L1:-}" "${L5:-}" "$LOAD_PER_CORE" "$LEDGER" "${TOP1:-}" "$EXTERNAL" "$OS"
else
  echo "=== MACHINE LOAD ASSESSMENT ==="
  echo "VERDICT: $VERDICT — $REASON"
  echo "  (scope: CPU capacity only — does NOT assess memory/swap/thermal/disk-IO)"
  echo ""
  echo "Real CPU:        ${BUSY:-?}% busy / ${IDLE:-?}% idle   (sampled, the primary signal)"
  echo "Cores:           ${CORES:-?} logical"
  echo "Agent CPU (1h):  $LEDGER   (instar ResourceLedger, time-windowed)"
  echo "Top consumer:    ${TOP1:-?}  →  $EXTERNAL"
  echo "Load avg (ctx):  1m=${L1:-?} 5m=${L5:-?}  (per-core ${LOAD_PER_CORE})  ← context only; spike-prone + I/O-inflated, NOT the verdict"
  echo ""
  echo "Top 3 CPU:"; echo "$TOP" | sed 's/^/  /'
  echo ""
  echo "Interpretation: trust the real CPU idle% + the time-windowed agent CPU."
  echo "A high load average with high idle% = external/transient (e.g. Spotlight), NOT agent pressure."
fi
exit 0
