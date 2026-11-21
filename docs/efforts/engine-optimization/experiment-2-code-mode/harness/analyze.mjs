// Verdict rule, fixed before results were read.
// Cost per successful task = ALL spend in the arm (failed runs included) / successful runs.
// ADOPT AS TRIAL only if saving >= 20% AND on-arm completion >= off-arm completion.
// EARLY STOP (first 4 tasks only): on-arm cost per success is not lower than off-arm.
import fs from 'node:fs';
const rows = fs.readFileSync('/private/tmp/claude-501/e2cm/harness/results.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
const stat = (a) => { const n=a.length, ok=a.filter(r=>r.success).length, cost=a.reduce((s,r)=>s+r.cost,0); return {n, ok, rate:n?ok/n:0, cost, cps:ok?cost/ok:null, turns:n?a.reduce((s,r)=>s+r.turns,0)/n:0, secs:n?a.reduce((s,r)=>s+r.ms,0)/n/1000:0}; };
const off=stat(rows.filter(r=>r.arm==='off')), on=stat(rows.filter(r=>r.arm==='on'));
const saving = off.cps&&on.cps ? 1-on.cps/off.cps : null;
const f=(x,d=3)=>x==null?'n/a':x.toFixed(d), pc=x=>x==null?'n/a':(x*100).toFixed(1)+'%';
const lines=['| Task | Off: done | On: done | Off: $/success | On: $/success | Saving |','| --- | --- | --- | --- | --- | --- |'];
const perTask=[];
for (const t of [...new Set(rows.map(r=>r.task))]) { const a=stat(rows.filter(r=>r.task===t&&r.arm==='off')), b=stat(rows.filter(r=>r.task===t&&r.arm==='on')); const s=a.cps&&b.cps?1-b.cps/a.cps:null; perTask.push({t,s}); lines.push(`| ${t} | ${a.ok}/${a.n} | ${b.ok}/${b.n} | ${f(a.cps)} | ${f(b.cps)} | ${pc(s)} |`); }
const wrongArm=rows.filter(r=>r.armOk===false).length, errors=rows.filter(r=>r.error||r.subtype==='none').length;
const adopt = saving!=null && saving>=0.20 && on.rate>=off.rate;
const earlyStop = saving==null || saving<=0;
console.log(lines.join('\n'));
console.log(JSON.stringify({runs:rows.length, off:{...off}, on:{...on}, saving:pc(saving), completionOff:pc(off.rate), completionOn:pc(on.rate), wrongArm, errors, tasksSaving:perTask.filter(x=>x.s>0).length, tasks:perTask.length, earlyStopRule:earlyStop, adoptBarMet:adopt},null,1));
