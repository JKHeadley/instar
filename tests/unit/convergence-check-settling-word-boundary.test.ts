/**
 * Unit tests for the SETTLING rule's word-boundary fix.
 *
 * THE BUG. The SETTLING alternation contained the fragment `there (is|are) no`
 * with no trailing boundary, so it matched INSIDE longer words that merely begin
 * with "no": "there is nothing", "there are none", "there is nobody". Those are
 * ordinary descriptive English, not an agent settling for an empty result, so the
 * gate blocked correct messages. Found 2026-07-30 when a second session of this
 * agent had a message blocked twice on "there is nothing pathological required".
 *
 * THE REAL DEFECT was bigger than the one character: the identical regex lived in
 * THREE places — the shell template, its TypeScript port, and an inline fallback
 * in PostUpdateMigrator used when the template cannot be loaded. Fixing only the
 * template would have left the port broken and shipped the bug to any agent whose
 * template load failed. The drift guard at the bottom is the structural half of
 * this fix; without it the three copies silently diverge again.
 *
 * TRUE POSITIVE PRESERVED BY A DIFFERENT BRANCH: "there is nothing to report" must
 * still block. It does — via the separate `nothing (to report|...)` alternative,
 * not via the fragment being removed. That is the assertion that proves the fix
 * narrows the rule without deleting its purpose.
 *
 * Discrimination: every test below was run against the UNFIXED source first.
 * Cases marked CONTROL pass either way and are NOT evidence for this change.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConvergence } from '../../src/core/ConvergenceChecker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'src/templates/scripts/convergence-check.sh');

/** Run the shell gate. Exit 0 = allowed through, non-zero = blocked. */
function shellBlocks(message: string): boolean {
  try {
    execFileSync('bash', [SCRIPT_PATH], {
      input: message,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return false;
  } catch {
    return true;
  }
}

function tsSettles(message: string): boolean {
  return checkConvergence(message).issues.some((i) => i.category === 'settling');
}

/** Sentences that are ordinary English, NOT a report of an empty search. */
const FALSE_POSITIVES = [
  'There is nothing pathological required.',
  'I checked and there are none of those left.',
  'There is nobody else on that machine.',
];

/** Genuine settling language that must keep blocking. */
const TRUE_POSITIVES = [
  'There is no data available for that window.',
  'Nothing was found in the logs.',
  'I could not find any matching row.',
];

describe('SETTLING rule — word boundary after "no" (shell template)', () => {
  it.each(FALSE_POSITIVES)('allows %j (DISCRIMINATES: blocked before the fix)', (msg) => {
    expect(shellBlocks(msg)).toBe(false);
  });

  it.each(TRUE_POSITIVES)('still blocks %j (CONTROL: blocks either way)', (msg) => {
    expect(shellBlocks(msg)).toBe(true);
  });

  it('still blocks "there is nothing to report" via the OTHER alternative (CONTROL)', () => {
    // The load-bearing check that the fix narrowed rather than gutted the rule:
    // the fragment no longer matches "nothing", but `nothing (to report|...)` does.
    expect(shellBlocks('There is nothing to report.')).toBe(true);
  });

  it('leaves an unrelated benign sentence alone (CONTROL)', () => {
    expect(shellBlocks('The build completed and all tests passed.')).toBe(false);
  });
});

describe('SETTLING rule — word boundary after "no" (TypeScript port)', () => {
  it.each(FALSE_POSITIVES)('allows %j (DISCRIMINATES)', (msg) => {
    expect(tsSettles(msg)).toBe(false);
  });

  it.each(TRUE_POSITIVES)('still flags %j (CONTROL)', (msg) => {
    expect(tsSettles(msg)).toBe(true);
  });

  it('still flags "there is nothing to report" via the OTHER alternative (CONTROL)', () => {
    expect(tsSettles('There is nothing to report.')).toBe(true);
  });
});

describe('SETTLING rule — drift guard across all three copies', () => {
  // One truth, three files. This guard is the reason the bug cannot come back in
  // only two of them.
  const COPIES = [
    'src/templates/scripts/convergence-check.sh',
    'src/core/ConvergenceChecker.ts',
    'src/core/PostUpdateMigrator.ts',
  ];
  const ANCHORED = 'there (is|are) no([^a-zA-Z]|$)';
  const UNANCHORED = 'there (is|are) no|';

  it.each(COPIES)('%s carries the anchored form', (rel) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
    expect(src).toContain(ANCHORED);
  });

  it.each(COPIES)('%s no longer carries the unanchored form', (rel) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
    expect(src).not.toContain(UNANCHORED);
  });

  it('the copies are not silently reduced to fewer than three (guard integrity)', () => {
    // Positive control for the guard itself: if someone deletes a copy, the
    // per-file assertions above would vacuously stop covering it. This asserts
    // the inventory is still what the fix reasoned about.
    for (const rel of COPIES) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
    }
    expect(COPIES).toHaveLength(3);
  });
});
