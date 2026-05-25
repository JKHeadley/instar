#!/usr/bin/env node
// safe-git-allow: pre-push bootstrap — read-only git only (merge-base / rev-parse
// / diff --name-only); runs before TS is compiled, so it can't use SafeGitExecutor.
/**
 * pre-push-e2e-scope — run the END-TO-END suite for the area being pushed.
 *
 * Why: the pre-push smoke tier (`test:push` / `test:smoke`) uses
 * `vitest.push.config.ts`, which EXCLUDES `tests/e2e/**`. So a change can pass
 * pre-push + the watched CI checks yet break the separate `E2E Tests` CI job —
 * exactly what turned main red in PR #381 (the threadline single-store refactor
 * left two e2e test harnesses stale; fixed in #383). A red e2e job blocks the
 * whole merge queue.
 *
 * This gate closes that hole structurally: when the push touches an
 * "e2e-load-bearing" source area, it runs that area's e2e suite BEFORE the push
 * is allowed — automatically, not by memory. It is PATH-SCOPED, so unrelated
 * pushes pay nothing.
 *
 * Opt out: INSTAR_PRE_PUSH_E2E_SKIP=1 git push  (CI still runs the full e2e job)
 */

import { execSync, spawnSync } from 'node:child_process';

if (process.env.INSTAR_PRE_PUSH_E2E_SKIP === '1' || process.env.INSTAR_PRE_PUSH_SKIP === '1') {
  console.log('⏭️  pre-push e2e scope skipped (env) — CI still runs the full e2e job.');
  process.exit(0);
}

/**
 * Map a changed-source-path matcher → the e2e suite path(s) that exercise it.
 * Extend this as more areas gain e2e coverage. Keep entries narrow so the gate
 * stays fast and only fires for the area actually changed.
 */
const SCOPE_MAP = [
  { match: /^src\/threadline\//, e2e: ['tests/e2e/threadline/'] },
  { match: /^tests\/e2e\/threadline\//, e2e: ['tests/e2e/threadline/'] },
  { match: /^tests\/helpers\/TestThreadResumeMap\.ts$/, e2e: ['tests/e2e/threadline/'] },
];

let changed = [];
try {
  // Changes on this branch since it diverged from origin/main. The pre-push
  // hook already fetched origin/main; fall back to HEAD~1 if the ref is absent.
  let base = '';
  try {
    base = execSync('git merge-base origin/main HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    base = execSync('git rev-parse HEAD~1', { encoding: 'utf-8' }).trim();
  }
  const out = execSync(`git diff --name-only ${base} HEAD`, { encoding: 'utf-8' });
  changed = out.split('\n').map(s => s.trim()).filter(Boolean);
} catch (err) {
  console.warn(`pre-push-e2e-scope: could not compute changed files (${err instanceof Error ? err.message : err}) — skipping (CI still runs e2e).`);
  process.exit(0);
}

const suites = new Set();
for (const file of changed) {
  for (const rule of SCOPE_MAP) {
    if (rule.match.test(file)) rule.e2e.forEach(s => suites.add(s));
  }
}

if (suites.size === 0) {
  process.exit(0); // nothing e2e-load-bearing changed — fast path
}

const suiteList = [...suites];
console.log(`🧪 pre-push e2e scope: changed files touch ${suiteList.join(', ')} — running their e2e suite(s)...`);
console.log('   Opt out: INSTAR_PRE_PUSH_E2E_SKIP=1 git push (CI still runs the full e2e job)');

const res = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'vitest.e2e.config.ts', ...suiteList],
  { stdio: 'inherit', encoding: 'utf-8' },
);

if (res.status !== 0) {
  console.error('❌ Scoped e2e suite failed. Fix before pushing, or INSTAR_PRE_PUSH_E2E_SKIP=1 to bypass (CI will still catch it).');
  process.exit(1);
}
console.log('✅ Scoped e2e suite passed.');
process.exit(0);
