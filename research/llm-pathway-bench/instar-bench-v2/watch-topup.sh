#!/bin/bash
# Watches the OpenRouter prepaid balance; when a top-up lands, launches the parked
# frontier-route benchmark resume run in a detached tmux session and notifies topic 29723.
# Runs detached (tmux ib2-topup-watch) so it survives agent-session respawns.
BENCH=/Users/justin/.instar/agents/echo/research/llm-pathway-bench
V2=$BENCH/instar-bench-v2
LOG=$V2/topup-watch.log
THRESHOLD=1

while true; do
  REM=$(node "$BENCH/check-credits.mjs" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(typeof j.remaining==='number'?j.remaining:'ERR')}catch(e){console.log('ERR')}})")
  echo "$(date '+%F %T') remaining=$REM" >> "$LOG"
  if [ "$REM" != "ERR" ] && [ -n "$REM" ]; then
    OK=$(node -e "console.log(Number('$REM')>=Number('$THRESHOLD')?'yes':'no')")
    if [ "$OK" = "yes" ]; then
      echo "$(date '+%F %T') TOP-UP DETECTED (\$$REM) — launching frontier resume run" >> "$LOG"
      tmux new-session -d -s ib2-frontier -c "$V2" \
        "node run2.mjs --stamp crit-metered --samples 2 --routes-filter metered --resume 2>&1 | tee -a '$V2/frontier-resume.log'; echo \"\$(date '+%F %T') ib2-frontier run EXITED\" >> '$LOG'"
      cat <<MSG | /Users/justin/.instar/agents/echo/.instar/scripts/telegram-reply.sh 29723
✅ OpenRouter top-up detected (\$$REM available) — the parked frontier benchmark run just started automatically (the 16 paid routes, resume-safe, every call through the budget wall). I'll score + run forensics on it when it lands.
MSG
      exit 0
    fi
  fi
  sleep 600
done
