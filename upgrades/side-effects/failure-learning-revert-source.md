# Side-Effects Review — Failure-Learning Revert Source (slice 1b)

**Slug:** `failure-learning-revert-source`
**Date:** 2026-05-28
**Author:** echo
**Spec:** `docs/specs/FAILURE-LEARNING-INGESTION-SOURCES-SPEC.md` §3.2 (CONVERGED v3.1, approved — Justin, topic 13201)

## Summary

Slice 1b of the ingestion-sources build: the `revert` automatic source (the second half of the approved "ci + revert" slice 1; slice 1a — CI source + substrate — already merged in PR #482). Off by default (`monitoring.failureLearning.sources.revert`); fail-open + near-silent.

## Files

- `src/monitoring/RevertDetector.ts` (NEW): scans recent commits for `Revert "…"`, extracts the reverted OID, and records reverts in the ledger. The highest-risk untrusted-input surface, hardened per §3.2:
  - **Auto-CLOSE cross-check:** a revert closes an existing open record ONLY if (1) the reverted OID is a reachable commit AND (2) the revert's diff intersects the reverted commit's files. A hand-written `This reverts commit <oid>` failing either check NEVER auto-closes — it may only open an `inferred` forensic record.
  - **Close match on initiative AND causeCommitOid** (not initiative alone — close-griefing protection).
  - **Revert² skip** (re-land is not a failure).
  - **ifMatch CAS retry** for the close (update() requires ifMatch).
  - **Idempotent** decision tree across ticks (trusted-close vs already-closed vs forensic-exists vs open-new) — no re-close, no duplicate forensic records.
  - Constant `filedBy:'source:revert'`; forensic records opened `status:'resolved'` (excluded from active clustering §6.1); loop self-exclusion (§4.3) inert until slice 2's `origin`.
  - Read-only git via `SafeGitExecutor.readSync` (injectable for tests); fail-open per-commit + per-tick.
- `src/server/AgentServer.ts`: construct `RevertDetector` gated on `failureLearning.enabled && sources.revert`; start post-listen; stop on shutdown (mirrors the CI poller).
- Tests: `tests/unit/RevertDetector.test.ts` (9 — parse, trusted close, failed-cross-check-no-close, no-original forensic, revert² skip, unreachable→inferred, loop-skip, idempotent, fail-open); `tests/unit/CiFailurePoller-wiring.test.ts` extended (revert detector constructed iff `enabled && sources.revert`; independent flags).

## Decision points

- **Dedicated scan vs fold into reconciler?** The spec said "fold into the existing reconciler commit-scan," but no clean periodic recent-commit scan exists (the merge-unreachability reconciler is per-initiative + lazy). Built a small dedicated `git log --grep=^Revert` scan on the reconciler cadence — same outcome, isolated + testable. Deviation noted.
- **Open forensic records as `resolved`?** Yes (§3.2) — a revert is a historical event, not an active failure; `resolved` → excluded from the analyzer's active clustering (§6.1). `open()` inserts `'open'`, so the detector flips it to `resolved` via the CAS path.
- **Close-or-open idempotency** required a 4-branch decision tree (trusted-close / already-trusted-closed / forensic-exists / open-new) so re-ticks neither re-close nor duplicate.

## Side-effects analysis

- **Behavioral:** Additive, off by default. When on, it only writes/closes ledger records; no user messaging, no build/request impact.
- **Security:** This is the untrusted-commit-message surface. The cross-check (reachability + diff intersection) + initiative+causeCommitOid close-match are the close-griefing mitigations; an untrusted revert can at most open an `inferred` forensic record (excluded from analysis). `detail.full` is short + non-secret-bearing (commit OIDs); the redaction contract is unaffected (it flows through the same `open()`/`toApiView`).
- **Migration:** `sources.revert` already shipped in the config block (slice 1a, default false); no new migration.
- **Reversibility:** Fully reversible; disabling the flag stops the detector (records stay inert).

## Evidence

- `tsc --noEmit` clean.
- 13 tests green: RevertDetector (9, both sides of every cross-check branch), wiring-integrity (4, CI + revert each constructed iff its flag). Existing failure-learning + slice-1a tests unaffected.
