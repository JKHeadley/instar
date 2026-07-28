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
 *   3. Release-note fragments (upgrades/next/*.md + legacy NEXT.md)
 *      assemble and validate cleanly — using the SAME assembler +
 *      validator the pre-push gate and publish workflow use. The
 *      pre-push gate already catches this locally, but local hooks are
 *      bypassable (admin/web merges, pre-guard history): a malformed
 *      fragment that reaches main jams EVERY subsequent fleet release
 *      at publish-time (lived twice: the v1.3.180 jam and #781 on
 *      2026-06-05). This server-side check runs on every PR and on
 *      main, so the jam is loud and attributable instead of silent.
 *
 * Exit 0 = invariants hold. Exit 1 = at least one violated; the
 * specific failures are printed to stderr.
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateGuideContent } from './upgrade-guide-validator.mjs';
import { assembleNextMd, gatherFragmentInputs } from './assemble-next-md.mjs';

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

// ── Release-note fragments assemble + validate ────────────────────
// Mirrors scripts/pre-push-gate.js §1 exactly (same shared functions), so a
// fragment that would jam publish.yml can never sit quietly on main. No
// fragments at all is FINE here — "src changed without a fragment" is the
// pre-push gate's per-branch concern; this invariant only asserts that
// whatever fragments DO exist are publishable.
{
  const upgradesDir = path.join(ROOT, 'upgrades');
  if (fs.existsSync(upgradesDir)) {
    try {
      const { inputs } = gatherFragmentInputs(upgradesDir);
      if (inputs.length > 0) {
        const assembled = assembleNextMd(inputs);
        for (const issue of validateGuideContent(assembled)) {
          failures.push(
            `Release-note fragments (upgrades/next/*.md + NEXT.md) fail validation: ${issue} ` +
            `— this would jam the publish workflow for EVERY release until fixed.`,
          );
        }
      }
    } catch (err) {
      failures.push(
        `Release-note fragments are malformed (assembly failed): ${err instanceof Error ? err.message : err} ` +
        `— this would jam the publish workflow for EVERY release until fixed.`,
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
