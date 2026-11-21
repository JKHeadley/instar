#!/bin/zsh
# Option C (PR head) three cold runs with per-request timing, each paired with a control run of the same
# server and log with the list path idle for the same length of time. Private copy of the agent's own
# log; localhost-only throwaway servers; messaging and outbound off; counts only; copy deleted after.
S=${0:A:h}; P=${OFFTHREAD_MEASURE_DIR:-${TMPDIR%/}/pr3609-proof}; mkdir -p $P
NEW=${1:?usage: measure.sh <worktree of the PR branch>}
R=$P/real-seed; umask 077; rm -rf $R; mkdir -p $R/.instar
LOG=${INSTAR_TELEGRAM_LOG:-$HOME/.instar/agents/echo/.instar/telegram-messages.jsonl}; cp "$LOG" $R/.instar/telegram-messages.jsonl
node $S/meta-from-log.mjs $R/.instar/telegram-messages.jsonl $R/fixture-meta.json > /dev/null
node $S/keys.mjs $P/keys > /dev/null
(cd $NEW && TOPIC_PREFIX="Real topic" npx tsx $S/serve.mts $R 4195 --seed "$(cat $P/keys/public.txt)" fixture-device-3609 > /dev/null 2>&1)
for i in 1 2 3; do
  # control: the same server and log, no requests, for as long as a measured run takes
  n=c7ctl$i; rm -rf $P/$n; cp -R $R $P/$n
  (cd $NEW && npx tsx $S/serve.mts $P/$n 4195 > $P/$n.server.log 2>&1 &)
  for k in {1..120}; do [ -f $P/$n/ready ] && break; sleep 0.5; done
  t0=$(date +%s); sleep 140; kill -TERM $(cat $P/$n/ready); for k in {1..40}; do [ -f $P/$n/event-loop.json ] && break; sleep 0.5; done
  echo "{\"secs\":$(( $(date +%s) - t0 ))}" > $P/$n.span.json
  # Option C, cold
  SEED=$R $S/run.sh c7optc$i $NEW > $P/c7optc$i.run.log 2>&1
done
node -e "
const fs=require('fs');const P='$P';const out={logBytes:fs.statSync('$R/.instar/telegram-messages.jsonl').size,runs:{}};
for (const i of [1,2,3]) {
  const ctl=JSON.parse(fs.readFileSync(P+'/c7ctl'+i+'/event-loop.json'));
  out.runs['control'+i]={maxStallMs:ctl.maxMs,stallsOver400:ctl.stalls.length,secs:JSON.parse(fs.readFileSync(P+'/c7ctl'+i+'.span.json')).secs};
  const el=JSON.parse(fs.readFileSync(P+'/c7optc'+i+'/event-loop.json'));const c=JSON.parse(fs.readFileSync(P+'/c7optc'+i+'.capture.json'));
  const listChat=el.slow.filter(s=>s.label.startsWith('/mobile/conversations')||s.label.startsWith('/telegram/topics'));
  out.runs['optionC'+i]={coldListMs:c.timings.coldListMs,warmListMs:c.timings.warmListMs,maxStallMs:el.maxMs,peakRssMb:el.peakRssMb,slowestRequests:el.slow.slice(0,4),slowestListOrChatMs:listChat.length?listChat[0].d:null,stallsOver400:el.stalls.map(s=>({gapMs:s.gapMs,inFlight:s.recent.slice(-1)[0]})),topics:c.coldList.rows.length};
}
fs.writeFileSync(P+'/c7-counts.json',JSON.stringify(out,null,2));"
python3 -c "import shutil,os,glob
P='$P'
for d in ['real-seed','keys']+[x for x in glob.glob(P+'/c7*') if os.path.isdir(x)]:
  p=d if d.startswith('/') else os.path.join(P,d)
  if os.path.isdir(p): shutil.rmtree(p)
for f in glob.glob(P+'/c7*.capture.json')+glob.glob(P+'/c7*.server.log'): os.remove(f)"
cat $P/c7-counts.json
