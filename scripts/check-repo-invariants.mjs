#!/usr/bin/env node
/**
 * Repository-state invariants — CI safety net (Layer 4 of the
 * test-env-isolation defense).
 *
 * Asserts properties of the checked-out tree that would otherwise be
 * easy to clobber without anyone noticing on a code-review pass:
 *
 *   1. README.md is at least MIN_README_LINES (default: 100). The
 *      "# Test Project" stub-on-main incident (PRs #130/#277) cut it
 *      to 1 line and shipped to npm.
 *   2. No fixture stowaway files at the repo root. file-0.txt and
 *      seed are signature artifacts of the test-fixture pollution
 *      class; they should never exist on main.
 *
 * Exit 0 = invariants hold. Exit 1 = at least one violated; the
 * specific failures are printed to stderr.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MIN_README_LINES = Number(process.env.INSTAR_README_MIN_LINES || 100);

const failures = [];

// ── README.md size floor ──────────────────────────────────────────
const readmePath = path.join(ROOT, 'README.md');
if (!fs.existsSync(readmePath)) {
  failures.push(`README.md is missing from repo root.`);
} else {
  const lines = fs.readFileSync(readmePath, 'utf-8').split('\n').length;
  if (lines < MIN_README_LINES) {
    failures.push(
      `README.md has ${lines} lines, below the ${MIN_README_LINES}-line floor. ` +
      `Likely test-fixture pollution clobbered the file. Restore from git history.`,
    );
  }
}

// ── Fixture stowaway files at repo root ───────────────────────────
const FIXTURE_STOWAWAYS = ['file-0.txt', 'seed'];
for (const name of FIXTURE_STOWAWAYS) {
  const p = path.join(ROOT, name);
  if (fs.existsSync(p)) {
    const stat = fs.statSync(p);
    if (stat.isFile()) {
      failures.push(
        `Fixture stowaway "${name}" exists at repo root. ` +
        `This is the signature of a test committing into the real repo. ` +
        `Delete the file and rebuild the test that produced it with sanitizedGitEnv().`,
      );
    }
  }
}

if (failures.length === 0) {
  console.log('✅ Repository invariants hold.');
  process.exit(0);
}

process.stderr.write('\n🚫 Repository invariants violated:\n\n');
for (const f of failures) {
  process.stderr.write(`  - ${f}\n`);
}
process.stderr.write('\n');
process.exit(1);
