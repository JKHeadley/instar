#!/usr/bin/env node
/**
 * pre-push-test-runner-selfdisable.mjs — the serverless-host self-disable
 * advisory for the test-runner concurrency bound
 * (docs/specs/test-runner-concurrency-bound.md §2.6(b), §2.9, §5 last bullet).
 *
 * Reads the LOCAL host-test-runner event ledger (live file + newest rotated
 * segments) and WARNs on a sustained self-disable pattern: `off` skips,
 * CI-reason skips on a non-CI host, defaulted/agent-context watch skips,
 * resolved-cap divergence (>4× authority), posture divergence (either
 * direction), and env-arm-ignored events. Detection logic lives ONCE in
 * scripts/lib/test-runner-selfdisable-patterns.mjs (shared with
 * `instar dev:preflight`, which spawns this script with --preflight).
 *
 * STRUCTURAL CONTRACT (spec §2.6 round-4 security + §5 last bullet): in
 * pre-push mode this script exits 0 UNCONDITIONALLY — on findings, on a
 * missing ledger, on a corrupt ledger, and on any internal error. The
 * detection surface for a self-disable must not itself become a new way to
 * wedge the dev loop (§1.1's false-BLOCK inversion): ledger content may only
 * ever ADD a warning, never block a push. A missing/unreadable ledger is
 * silent (no ledger = nothing to warn about).
 * tests/unit/test-runner-selfdisable-patterns.test.ts pins this by spawning
 * this real script against a pattern-heavy fixture ledger and asserting
 * exit 0 with WARN on stderr.
 *
 * --preflight mode (spawned by `instar dev:preflight`, a deliberate human
 * advisory tool that MAY fail per §2.6): exits 1 ONLY for the two unambiguous
 * self-disable signatures (sustained `off`; spoofed CI on a non-CI host —
 * both graded "like `off`" by the spec). The divergence/watch patterns WARN
 * without failing even there (they keep plausible legitimate explanations —
 * emergency env scoping, a deliberate interactive watch).
 */

import {
  PREFLIGHT_FAIL_PATTERNS,
  formatWarnLines,
  runSelfDisableCheck,
} from './lib/test-runner-selfdisable-patterns.mjs';

const preflightMode = process.argv.includes('--preflight');
let preflightExit = 0;

try {
  const result = runSelfDisableCheck();
  if (result.ledgerPresent && result.findings.length > 0) {
    for (const line of formatWarnLines(result.findings)) {
      process.stderr.write(`⚠️  ${line}\n`);
    }
    if (
      preflightMode &&
      result.findings.some((f) => PREFLIGHT_FAIL_PATTERNS.includes(f.pattern))
    ) {
      preflightExit = 1;
      process.stderr.write(
        'preflight: unambiguous self-disable pattern (sustained `off` / spoofed CI) — ' +
          'failing advisorily (§2.6: dev:preflight MAY fail; the pre-push surface never does).\n',
      );
    }
  } else if (preflightMode) {
    process.stdout.write(
      'test-runner bound self-disable ledger check: clean (no sustained pattern, or no local ledger yet).\n',
    );
  }
  // Pre-push mode: a missing/unreadable ledger or zero findings is SILENT.
} catch (err) {
  // Never let the detection surface wedge the dev loop (§1.1): any internal
  // error is advisory noise at most, in BOTH modes.
  try {
    process.stderr.write(
      `test-runner self-disable check errored (advisory, ignored): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  } catch {
    /* stderr unavailable — nothing left to do */
  }
}

// WARN-only: pre-push mode exits 0 unconditionally; only --preflight may
// carry the advisory failure (and only for PREFLIGHT_FAIL_PATTERNS).
process.exit(preflightMode ? preflightExit : 0);
