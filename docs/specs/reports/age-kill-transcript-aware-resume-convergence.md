# Convergence Report — Age-Kill Transcript-Awareness

## ⚠ Cross-model review: DEGRADED — ALL ROUNDS (degraded-all-rounds)

The external (non-Claude) reviewer pass did NOT yield a successful opinion this convergence.
`codex` was not on this session's PATH (recorded active in the 7-day history, but the CLI was
not invocable here), and the `gemini` pass DEGRADED — the gemini CLI returned
`API returned invalid content after all retries (retry attempts exhausted)`. Per the aggregation
rule this is `degraded-all-rounds`: a non-Claude framework was present in the lookback but zero
external rounds succeeded. **The spec converged on the SIX internal Claude reviewers + the
code-backed Standards-Conformance gate only.** The reader should weigh this reduced external
assurance before approving — though note the change is a ~60-LOC, dark-safe, single-decision-path
fix with an extensive internal + constitutional review.

## ELI10 Overview

A watchdog retires very old agent sessions (~5h) but is supposed to spare ones still working.
Its "still working?" test couldn't see work done through the browser/plug-in tools, so it killed
a busy session by mistake. This change teaches that watchdog the same trick the system's *other*
reaper already uses: check whether the session's live activity log was written in the last couple
of minutes. If it was, the session is busy — don't kill it. Nothing else changes; the watchdog
can now only be *more* careful, never less.

## Original vs Converged

The original spec already proposed the core fix (transcript-mtime check in the age gate) plus the
`isTranscriptRecentlyActive` probe. Review changed it in four ways:

1. **Reproduce-the-failure test (Bug-Fix Evidence Bar).** The idle decision was extracted into a
   pure, exported `isAgeGateTrulyIdle(...)` so the EXACT incident inputs (idle pane + no child
   proc + a growing transcript) are unit-tested to resolve to "deferred, not killed" — the
   original plan tested the probe in isolation but never reproduced the actual failure.
2. **Denial-of-reaping rationale (§4.1).** Security flagged that a session can stay alive by
   keeping its transcript fresh. The spec now documents this is INTENDED and safe: only real
   model activity refreshes the transcript, it matches the existing SessionReaper policy, the
   operator explicitly asked for it, and runaway-but-active sessions are owned by other guards.
3. **pi-cli safe-degradation (§3.1).** Two reviewers found `resolveFrameworkTranscriptPath` has
   no pi-cli case (a pre-existing shared-foundation gap affecting all transcript consumers). The
   spec now documents that pi-cli (and any unresolvable framework) safely degrades to today's
   pane/procs behavior — no regression — and tracks the resolver gap as separate work.
4. **Test-tier applicability (§6.1) + cross-framework coverage.** Integration/E2E tiers are
   recorded N/A-with-reason (no route/DI/HTTP surface; a real >5h E2E is impractical), and a
   cross-framework safe-degradation test (codex-cli + pi-cli) was added.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | conformance(Testing Integrity, Bug-Fix Evidence Bar), security, integration, lessons-aware | 6 | §6.1 tier-applicability; `isAgeGateTrulyIdle` extraction + repro test; §4.1 denial-of-reaping rationale; §3.1 pi-cli safe-degradation + mtime/delta asymmetry; cross-framework test; framework-parity wording fix |
| 2 | (convergence check) | 0 new | none — conformance gate returns NO FINDINGS; checker verdict CONVERGED |

Standards-Conformance Gate: round 1 — ran (2 flags: Testing Integrity, Bug-Fix Evidence Bar); round 2 — ran (0 flags).

## Full Findings Catalog

- **[HIGH] security — denial-of-reaping:** active session stays alive via fresh transcript →
  RESOLVED as intended design (§4.1): real-activity-only refresh, matches SessionReaper, operator
  intent, runaway owned by SessionWatchdog/pressure-reaper.
- **[HIGH] integration + lessons-aware — pi-cli resolver fallthrough:** transcript-deferral inert
  for pi-cli → RESOLVED via documented safe-degradation (no regression) + tracked foundation gap (§3.1).
- **[MEDIUM] integration — cross-framework test gap:** RESOLVED, codex-cli + pi-cli safe-degrade
  test added (§6).
- **[LOW] integration — implied framework parity:** RESOLVED, §3.1 documents per-framework coverage.
- **[conformance] Testing Integrity (missing tiers):** RESOLVED, §6.1 N/A-with-reason.
- **[conformance] Bug-Fix Evidence Bar (reproduce failure):** RESOLVED, decision-boundary repro test.
- **[lessons-aware] single-point mtime vs cross-tick delta asymmetry:** RESOLVED, §3.1 documents
  the intentional, benign asymmetry.
- **adversarial, scalability, decision-completeness:** NO MATERIAL FINDINGS (loop-safety confirmed;
  negligible per-tick statSync cost; no parked user-decisions).

## Convergence verdict

Converged at iteration 2. No material findings in the verification round; the code-backed
conformance gate returns NO FINDINGS on the converged spec. Spec is ready for user review and
approval. External (non-Claude) assurance was degraded this run (see banner).
