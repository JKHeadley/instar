#!/usr/bin/env node
/**
 * measure-refusal-arm-coverage.mjs — how much of the guard family's refusal surface is actually tested.
 *
 * ── Why this file exists, and why it is a FILE and not a number in a sentence ──────────────────────
 * Review pass 27 finding 7. I derived this figure once by mutation, reported it in a message, and never
 * landed it. Then I carried it into review prompts as though the repository declared it. Review pass 26
 * cited it as a tree declaration to justify withholding seventeen surviving mutants; review pass 27
 * grepped the tree for it and found NOTHING — the only figure the repository actually stated was "roughly
 * 40% with nothing measuring it", itself derived over a much smaller surface than the current one. (NEITHER
 * the arm count NOR the test count is written here, and the arm count's absence is a repair: review pass 29
 * finding 4 found this sentence stating "the arm count is now 90" while re-deriving with this script's own
 * two rules gave 91 — stale by one, in the file whose entire subject is that a figure must be re-derived
 * rather than believed. Re-derived again 2026-08-11: still 91.
 *
 * The sharp part, recorded because it is this branch's signature and it happened INSIDE the sentence that
 * teaches against it: the very next clause already said the TEST count was deliberately omitted because a
 * hardcoded number goes stale — and the arm count sat hardcoded one clause away. The lesson was applied to
 * one number and not to its sibling. Both are gone now, for the same reason: this script PRINTS `total` on
 * every run, so the count belongs in its output where it cannot disagree with itself. Run it and read it.)
 *
 * A measurement that lives only in a message is not a measurement the work has. That is this registry's
 * own "untracked = abandoned" standard, broken with the very number I was pleased about.
 *
 * ── Method, so the figure can be re-derived rather than believed ───────────────────────────────────
 * Mutation, not string-matching. Two earlier string-based attempts produced 0% and 13% and were both
 * untrustworthy — one parsed code fragments, one saw 10 of 14 assertions. This neuters each refusal arm
 * in turn and asks whether ANY behavioural test reds.
 *
 * The population is BOTH refusal mechanisms, because an earlier version counted only `failures.push(` and
 * read the fingerprint guard as 0/7 — false, since its covered arms refuse via an early `console.error` +
 * `process.exit(1)`. A denominator that omits a whole mechanism is the narrow-population defect this
 * branch keeps finding, one level up, in its own instrument.
 *
 * Run it in an isolated `git archive` clone — never against a tree a reviewer is reading.
 *
 * ── What it does NOT say ───────────────────────────────────────────────────────────────────────────
 * Coverage is not correctness. A covered arm is one some test notices when it stops refusing; it is not
 * proof the arm refuses the RIGHT things.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const GUARDS = [
  'scripts/lint-enforcement-fingerprint.mjs','scripts/lint-enforcement-gap-records.mjs',
  'scripts/lint-documented-only-countdown.mjs','scripts/lint-deferral-referent-resolves.mjs',
  'scripts/lint-account-matches-tree.mjs','scripts/lint-registry-self-counts.mjs',
];
const TEST='tests/unit/window10-guards-behaviour.test.ts';
const run=()=>{try{execSync(`npx vitest run ${TEST} 2>&1`,{encoding:'utf-8',stdio:'pipe'});return 'green';}
  catch(e){const o=`${e.stdout??''}${e.stderr??''}`;return /Tests\s+\d+\s+failed/.test(o)?'red':'err';}};
const rows=[];
// RESTORE IS NOW GUARANTEED. Review pass 29 finding 8 recorded that this script mutates the guards in
// place with no try/finally and no signal handler, and that a reviewer running it was interrupted and left
// a neutered guard behind — "Structure > Willpower" inverted inside the branch that states it. Pass 31
// found the same gap still open at the write site. Every mutation is now paired with a finally, and an
// interrupt restores every file this process has touched before exiting.
const DIRTY = new Map();               // path -> original contents
const restoreAll = () => { for (const [f, o] of DIRTY) { try { fs.writeFileSync(f, o); } catch {} } DIRTY.clear(); };
for (const sig of ['SIGINT','SIGTERM','SIGHUP']) process.on(sig, () => { restoreAll(); process.exit(130); });
process.on('uncaughtException', (e) => { restoreAll(); throw e; });

for (const g of GUARDS) {
  const orig=fs.readFileSync(g,'utf-8');
  DIRTY.set(g, orig);
  const idx=[]; let at=0; for(;;){const i=orig.indexOf('failures.push(',at); if(i<0)break; idx.push(i); at=i+1;}
  for (const i of idx) {
    const line=orig.slice(0,i).split('\n').length;
    let v;
    try {
      fs.writeFileSync(g, `${orig.slice(0,i)}void 0 && ${orig.slice(i)}`);
      v = run();
    } finally { fs.writeFileSync(g, orig); }
    rows.push({g:g.replace('scripts/',''),line,kind:'failures.push',v});
    process.stderr.write(v==='red'?'C':v==='green'?'.':'!');
  }
  const lines=orig.split('\n'); const exits=[];
  lines.forEach((l,i)=>{ if(!/process\.exit\(1\)/.test(l))return;
    if(!/console\.error\(/.test(lines.slice(Math.max(0,i-14),i).join('\n')))return; exits.push(i);});
  for (const i of exits) {
    const mut=[...lines]; mut[i]=mut[i].replace('process.exit(1)','process.exit(0)');
    for(let j=i-1;j>=Math.max(0,i-14);j--){ if(/console\.error\(/.test(mut[j])){mut[j]=mut[j].replace('console.error(','void 0 && console.error(');break;} }
    let v;
    try { fs.writeFileSync(g, mut.join('\n')); v = run(); } finally { fs.writeFileSync(g, orig); }
    rows.push({g:g.replace('scripts/',''),line:i+1,kind:'early-exit',v});
    process.stderr.write(v==='red'?'C':v==='green'?'.':'!');
  }
  DIRTY.delete(g);
}
restoreAll();
process.stderr.write('\n');
// "the tests could not run" is NOT "0% covered". Pass 31 finding 3 executed this with a missing test path
// and got {"total":4,"covered":0,"ratio":0} and exit 0 — a measuring instrument reporting a confident
// number without having measured anything, which is the exact class article 89 governs. Errored rows are
// now EXCLUDED from the denominator, reported separately, and a run that measured nothing exits non-zero.
const errs=rows.filter(r=>r.v==='err');
const measured=rows.filter(r=>r.v!=='err');
const cov=measured.filter(r=>r.v==='red').length;
if (measured.length===0) {
  console.error(`[measure] NOTHING WAS MEASURED — all ${rows.length} mutation(s) errored (the test could not run). Refusing to report a ratio.`);
  process.exit(1);
}
console.log(JSON.stringify({total:measured.length,covered:cov,ratio:+(cov/measured.length).toFixed(4),
  erroredUnmeasured:errs.length,
  perGuard:Object.fromEntries([...new Set(rows.map(r=>r.g))].map(g=>{const s=rows.filter(r=>r.g===g);
    const m=s.filter(r=>r.v!=='err');
    return [g,{covered:m.filter(r=>r.v==='red').length,total:m.length,erroredUnmeasured:s.length-m.length}];}))},null,2));
