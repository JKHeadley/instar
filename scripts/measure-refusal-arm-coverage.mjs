#!/usr/bin/env node
/**
 * measure-refusal-arm-coverage.mjs — how much of the guard family's refusal surface is actually tested.
 *
 * ── Why this file exists, and why it is a FILE and not a number in a sentence ──────────────────────
 * Review pass 27 finding 7. I derived this figure once by mutation, reported it in a message, and never
 * landed it. Then I carried it into review prompts as though the repository declared it. Review pass 26
 * cited it as a tree declaration to justify withholding seventeen surviving mutants; review pass 27
 * grepped the tree for it and found NOTHING — the only figure the repository actually stated was "roughly
 * 40% with nothing measuring it", itself derived over 57 sites and 23 tests when the arm count is now 90. (The test count is
 * deliberately NOT written here: review pass 28 found the number I put in this sentence was produced by
 * a grep, not a run, and differed from the one in my own commit body — in the file whose subject is that
 * a measurement must be re-derived rather than believed. Run the suite; it prints the count.)
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
for (const g of GUARDS) {
  const orig=fs.readFileSync(g,'utf-8');
  const idx=[]; let at=0; for(;;){const i=orig.indexOf('failures.push(',at); if(i<0)break; idx.push(i); at=i+1;}
  for (const i of idx) {
    const line=orig.slice(0,i).split('\n').length;
    fs.writeFileSync(g, `${orig.slice(0,i)}void 0 && ${orig.slice(i)}`);
    const v=run(); fs.writeFileSync(g,orig);
    rows.push({g:g.replace('scripts/',''),line,kind:'failures.push',v});
    process.stderr.write(v==='red'?'C':v==='green'?'.':'!');
  }
  const lines=orig.split('\n'); const exits=[];
  lines.forEach((l,i)=>{ if(!/process\.exit\(1\)/.test(l))return;
    if(!/console\.error\(/.test(lines.slice(Math.max(0,i-14),i).join('\n')))return; exits.push(i);});
  for (const i of exits) {
    const mut=[...lines]; mut[i]=mut[i].replace('process.exit(1)','process.exit(0)');
    for(let j=i-1;j>=Math.max(0,i-14);j--){ if(/console\.error\(/.test(mut[j])){mut[j]=mut[j].replace('console.error(','void 0 && console.error(');break;} }
    fs.writeFileSync(g,mut.join('\n')); const v=run(); fs.writeFileSync(g,orig);
    rows.push({g:g.replace('scripts/',''),line:i+1,kind:'early-exit',v});
    process.stderr.write(v==='red'?'C':v==='green'?'.':'!');
  }
}
process.stderr.write('\n');
const cov=rows.filter(r=>r.v==='red').length;
console.log(JSON.stringify({total:rows.length,covered:cov,ratio:+(cov/rows.length).toFixed(4),
  perGuard:Object.fromEntries([...new Set(rows.map(r=>r.g))].map(g=>{const s=rows.filter(r=>r.g===g);
    return [g,{covered:s.filter(r=>r.v==='red').length,total:s.length}];}))},null,2));
