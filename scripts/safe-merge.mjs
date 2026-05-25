#!/usr/bin/env node
/**
 * safe-merge — merge a PR ONLY after every check (incl. the e2e job) is green.
 *
 * Why: we merge with `gh pr merge --admin` to jump the hot-branch queue, but
 * `--admin` BYPASSES branch-protection's required-checks enforcement — which is
 * how PR #381 merged while the `E2E Tests` job was red and turned main red for
 * everyone. This wrapper re-imposes the requirement that `--admin` removes:
 * it waits for all checks to finish, refuses the merge if ANY check failed (and
 * specifically verifies an e2e check ran + passed), and only then merges.
 *
 * Usage:  node scripts/safe-merge.mjs <PR#> [--admin] [--squash|--merge|--rebase]
 *   --admin       still allowed (for the BEHIND/hot-branch case) — but ONLY
 *                 reached AFTER this script has confirmed every check is green.
 *   default merge method: --merge
 *
 * Exit non-zero (and do NOT merge) on any red/failed check.
 */

import { execSync, spawnSync } from 'node:child_process';

const REPO = 'JKHeadley/instar';
const args = process.argv.slice(2);
const pr = args.find(a => /^\d+$/.test(a));
const useAdmin = args.includes('--admin');
const method = args.find(a => ['--squash', '--merge', '--rebase'].includes(a)) || '--merge';

if (!pr) {
  console.error('usage: node scripts/safe-merge.mjs <PR#> [--admin] [--squash|--merge|--rebase]');
  process.exit(2);
}

function checks() {
  // gh pr checks exits non-zero when checks are failing/pending; capture either way.
  const r = spawnSync('gh', ['pr', 'checks', pr, '--repo', REPO], { encoding: 'utf-8' });
  return (r.stdout || '') + (r.stderr || '');
}

// Poll until nothing is pending (cap ~20 min).
console.log(`safe-merge: waiting for PR #${pr} checks to finish...`);
const deadline = Date.now() + 20 * 60 * 1000;
let out = checks();
while (/\bpending\b/.test(out)) {
  if (Date.now() > deadline) {
    console.error('safe-merge: timed out waiting for checks. NOT merging.');
    process.exit(1);
  }
  execSync('sleep 15');
  out = checks();
}

// Parse rows: "<name>\t<state>\t<elapsed>\t<url>". States: pass | fail | skipping | ...
const rows = out.split('\n').map(l => l.trim()).filter(Boolean);
const failed = [];
let sawE2e = false;
let e2ePassed = false;
for (const line of rows) {
  const cols = line.split('\t').map(c => c.trim());
  const name = cols[0] || '';
  const state = (cols[1] || '').toLowerCase();
  if (!name || !state) continue;
  const ok = state === 'pass' || state === 'skipping' || state === 'neutral';
  if (/e2e/i.test(name)) {
    sawE2e = true;
    if (state === 'pass') e2ePassed = true;
  }
  if (!ok) failed.push(`${name}: ${state}`);
}

if (failed.length > 0) {
  console.error(`safe-merge: REFUSING — ${failed.length} check(s) not green:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
if (!sawE2e) {
  console.error('safe-merge: REFUSING — no e2e check found in the PR checks. The e2e job is the one --admin bypasses; do not merge without it. (Override only with explicit human sign-off.)');
  process.exit(1);
}
if (!e2ePassed) {
  console.error('safe-merge: REFUSING — an e2e check is present but did not report pass.');
  process.exit(1);
}

console.log(`safe-merge: all checks green (e2e confirmed). Merging PR #${pr} (${method}${useAdmin ? ' --admin' : ''})...`);
const mergeArgs = ['pr', 'merge', pr, '--repo', REPO, method];
if (useAdmin) mergeArgs.push('--admin');
const m = spawnSync('gh', mergeArgs, { stdio: 'inherit', encoding: 'utf-8' });
process.exit(m.status ?? 0);
