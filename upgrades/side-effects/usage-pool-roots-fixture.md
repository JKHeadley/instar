# Side-Effects Review — Order the usage-ledger fixture before its event

**Version / slug:** `usage-pool-roots-fixture`
**Date:** 2026-11-22
**Author:** echo
**Second-pass reviewer:** reset_spec_integration (independent small-change review)

## Summary of the change

Tier 1, small and reversible. One unit-test fixture changes; its plain-language overview and this required review accompany it. The test creates both original files before choosing their event timestamp and then writes their observations. The previous thirty-millisecond guess could expire before the Claude file was created under load. Production code, all assertions and the real backup-age wait remain unchanged. One review pass; commit/gate attempts are recorded in the work evidence.

## Decision-point inventory

Only fixture construction order changes. There is no production decision point, account routing, credential mutation or new authority.

## 1. Over-block

No runtime block/allow surface. A real failure to count an original or deduplicate copied history still fails the same assertions.

## 2. Under-block

No runtime safeguard is loosened. The fixture does not simulate every filesystem clock anomaly; its event is explicitly at or after both recorded original birth times.

## 3. Level-of-abstraction fit

The incorrect assumption is in test setup. The production ledger's original-versus-copy classification is left intact.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). There is no runtime authority change. The test continues to surface a failure signal to normal verification.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The fixture establishes a causal ordering rather than choosing a timeout to stand in for it.

## 5. Interactions

Both original files retain their birth times when rewritten. The later backup creation still occurs after the existing 1130 ms wait, preserving Codex's one-second copied-history tolerance. Both backup-first and original-first scan orders remain tested, as does repeat-scan idempotency.

## 6. External surfaces

No user-facing or external runtime surface changes. No account, model, configuration or saved transcript is touched outside temporary test fixtures.

## 6b. Operator-surface quality

No operator surface changes. The accompanying overview explains the test repair in ordinary language.

## 7. Multi-machine posture

The test fix is replicated through source control and runs on every verification machine. Fixture files are machine-local because filesystem birth times are physical local observations; they never enter agent synchronization.
machine-local-justification: hardware-bound-resource

## 8. Rollback cost

Revert the test commit. No data migration, credential restoration or account change is needed.

## Evidence pointers

- Retained Windows full-run evidence: `.instar/recovery/retention1961/pr3625-manual-full-suite.log` on the Studio. This is separate from main's failed-file-only record; no missing main assertion is fabricated.
- Controlled old-fixture delay: `.instar/recovery/token-reset-routing/usage-pool-roots-delay-red.log` on the Studio. A 60 ms delay reproduced calls 1, input 123 and output 7 instead of calls 2, input 132 and output 10.
- Corrected fixture and identical delayed diagnostic: `.instar/recovery/token-reset-routing/usage-pool-roots-delay-green.log` on the Studio. The diagnostic file is temporary and is not part of this pull request.
- Independent small-change review concurred: no material findings; all assertions and production logic remain intact.
- Full verification remains the normal shared Local Verify gate; targeted evidence is not claimed as a complete suite pass or a deployment.


## Current-main verification repair (2026-11-22)

The original exact7fb451e6d7fb63ad216d827d93c5acbab658f510 complete gate failed in console-chats-page.test.ts, not in this ledger file. The coordinator retained the failed filename/count but its original assertion artifact is absent; neither this artifact nor source comparison reconstructs that historical assertion or proves its cause.

This merge brings the unchanged ledger fixture repair onto mainbc7d28135a7d298b68526d70a49a19856e9cc73e. The index retains main's console fixture byte-for-byte at blob473d0d1ed9c91a249c01cea530f84130927426f5 (the shared3655 lifecycle correction). No console assertions, native Web Locks or timeouts are edited by this repair. Independent base-alignment review concurred with no material findings. One new Node22 focused run of ledger8 plus console29 checks passed37/37; this is new supporting evidence, not a recovered historical assertion or full-gate clearance. A new normal complete gate on the corrected exact head is required before merge. Retained proof: .instar/recovery/token-reset-routing/usage-repair-current-main-focused.log.
