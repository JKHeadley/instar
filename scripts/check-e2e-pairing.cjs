#!/usr/bin/env node
// safe-git-allow: pre-commit-bootstrap — read-only `git diff --cached` to scan staged file list; runs before TS compile so cannot use SafeGitExecutor funnel.
/**
 * E2E-pairing gate — pre-commit check.
 *
 * Cherry-pick from the GSD-Instar integration spike. The spike's Tier-3
 * "feature is alive" finding: features that ship with API routes but no
 * E2E lifecycle test silently return 503 in production. CLAUDE.md calls
 * the Tier-3 test "the single most important test for any feature with
 * API routes" — but nothing structurally enforced its presence.
 *
 * This gate: if a commit stages a non-test `src/server/*.ts` file, it must
 * also stage at least one `tests/e2e/*.test.ts` file. Otherwise the commit
 * is blocked with a remediation message.
 *
 * This is a SIGNAL with commit-time authority — it errs toward false
 * positives (a server refactor that genuinely needs no new e2e test is
 * rarer than a feature shipped without one). Two escape hatches keep it
 * from being tyrannical:
 *   1. Env bypass: INSTAR_SKIP_E2E_PAIRING=1 git commit ...
 *   2. Marker: include "E2E-PAIRING: EXEMPT — <reason>" in any staged
 *      server file (for genuine refactors / type-only / comment changes).
 *
 * Exit codes:
 *   0 — pass (no server change, or e2e test paired, or exempt)
 *   1 — block (server change with no paired e2e test and no exemption)
 */

const { execSync } = require('node:child_process');

if (process.env.INSTAR_SKIP_E2E_PAIRING === '1') {
  process.exit(0);
}

function stagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf-8' });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    // If we can't read the index, don't block the commit.
    return [];
  }
}

function stagedContent(file) {
  try {
    return execSync(`git show :${file}`, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

const files = stagedFiles();

// Server source files (excluding tests + type-declaration files).
const serverChanges = files.filter(f =>
  /^src\/server\/.*\.ts$/.test(f) &&
  !/\.test\.ts$/.test(f) &&
  !/\.d\.ts$/.test(f)
);

if (serverChanges.length === 0) {
  process.exit(0); // No server change — nothing to enforce.
}

// Paired E2E test staged in the same commit?
const hasE2e = files.some(f => /^tests\/e2e\/.*\.test\.ts$/.test(f));
if (hasE2e) {
  process.exit(0);
}

// Exemption marker in any staged server file?
const exemptMarker = /E2E-PAIRING:\s*EXEMPT\s*[—-]/;
for (const f of serverChanges) {
  if (exemptMarker.test(stagedContent(f))) {
    process.exit(0);
  }
}

// Block.
console.error('');
console.error('╔════════════════════════════════════════════════════════════════════╗');
console.error('║  E2E-PAIRING GATE — server change without a paired E2E test          ║');
console.error('╚════════════════════════════════════════════════════════════════════╝');
console.error('');
console.error('  Staged server source files:');
for (const f of serverChanges) console.error(`    ${f}`);
console.error('');
console.error('  No tests/e2e/*.test.ts file is staged in this commit.');
console.error('');
console.error('  CLAUDE.md: the Tier-3 "feature is alive" E2E test is the single most');
console.error('  important test for any feature with API routes. Features that ship');
console.error('  with routes but no E2E lifecycle test silently return 503 in prod.');
console.error('');
console.error('  Fix one of:');
console.error('    1. Add/modify a tests/e2e/*.test.ts that boots the real server path');
console.error('       and hits the route, then stage it.');
console.error('    2. Genuine refactor / type-only / comment change? Add a comment');
console.error('       "E2E-PAIRING: EXEMPT — <reason>" to a staged server file.');
console.error('    3. One-off bypass: INSTAR_SKIP_E2E_PAIRING=1 git commit ...');
console.error('');
process.exit(1);
