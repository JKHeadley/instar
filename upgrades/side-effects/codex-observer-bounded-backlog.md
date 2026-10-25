# Side-Effects Review — Codex observer bounded backlog

**Version / slug:** `codex-observer-bounded-backlog`
**Date:** `2026-09-04`
**Author:** Codex
**Second-pass reviewer:** independent Codex reviewer

## Summary of the change

The Codex delivery observer now advances every complete JSONL prefix inside its bounded read even when the byte budget ends partway through the next record. The incomplete tail is left unread and starts the next sweep. A single record with no newline inside the full budget remains typed `unknown`.

This was found by the exact-candidate Stage-B canary: all 50 dedicated rows converged, but three real messages in busy sessions generated more than 256 KiB between sweeps. The old scanner marked the entire valid backlog unknown solely because byte 262,144 was not a newline, even though hundreds of complete record boundaries preceded it. Transcript inspection proved the injected user events and assistant responses were present.

## Decision-point inventory

- `scanSharedRollout` — modify — advances only through the last complete newline in a bounded read.
- `scanRollout` — modify — applies the same prefix rule to the compatibility scanner.

## 1. Over-block

No new block is introduced. A record larger than the entire per-row budget still has no complete boundary and remains unknown; schema drift and malformed complete JSON remain unknown.

## 2. Under-block

An incomplete tail is not parsed or trusted. It is re-read from its exact first byte on the next sweep. The cursor advances only to a verified newline, so no partial JSON can be skipped or treated as evidence.

## 3. Level-of-abstraction fit

This is byte-framing behavior in the JSONL scanner, the layer that owns cursor advancement. It does not change delivery authority, replay policy, or message interpretation.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

- [x] No — this change has no block/allow judgment surface.

No new judgment is added. A complete newline is structural framing evidence; absence of any boundary at the hard budget remains the conservative uncertainty floor.

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals decision point. This is an enumerable JSONL framing invariant: only bytes through a complete newline may advance the durable cursor.

## 5. Interactions

- **Races:** scans use the stat/read prefix already in place; bytes appended after the read wait for a later sweep.
- **Budgets:** each sweep still reads at most the configured per-row and aggregate limits.
- **Retries:** progress is durable in `inbound_rollout_cursor`; restart resumes from the last complete boundary.
- **Failure posture:** malformed complete JSON, unsupported events, identity mismatch, truncation, and an oversized single record still fail closed.

## 6. External surfaces

Busy Codex sessions no longer show false unknown delivery outcomes or strand valid messages from observability merely because their transcript grew by more than one scan budget. No API shape or user-facing wording changes.

## 6b. Operator-surface quality

No operator surface is changed — not applicable.

## 7. Multi-machine posture

Machine-local by design: each observer reads the local transcript for the delivery effect performed on that machine. Ownership and transfer fencing are unchanged.

## 8. Rollback cost

Pure scanner code; revert is mechanically simple but would restore demonstrated false-unknown outcomes under large valid transcript bursts.

## Conclusion

The first canary correctly refused certification after exposing three false unknowns. The fix preserves every hard bound and uncertainty rule while distinguishing a safely resumable complete prefix from a truly boundary-free oversized record. Unit, integration, and production-wired E2E tests cover the non-aligned multi-budget case. The fresh exact candidate subsequently passed 50/50 deliveries over 7,213,141 ms, the complete case matrix, 30/30 responsiveness samples, and zero forbidden outcomes; its signed evidence is now bound to the certified sources.

## Second-pass review

Concur. Cursor advancement is restricted to complete newline boundaries, partial bytes remain unread, and the next sweep revalidates them from the record start. The change cannot authorize delivery or replay and narrows false uncertainty without weakening malformed-input handling. The reviewer noted that the compatibility scanner needed the same direct regression assertion as the production shared path; that coverage was added before commit.

## Evidence pointers

- `tests/unit/CodexDeliveryObserver.test.ts`
- `tests/integration/codex-observer-bounded-backlog.test.ts`
- `tests/e2e/codex-session-lifecycle-reliability.test.ts`
- First canary ledger: 50/50 dedicated rows responded; three candidate-window false unknowns on busy sessions identified at non-aligned >256 KiB backlogs.
- Corrected canary ledger: 50/50 rows consumed/cleared/responded; zero false unknown, exhaustion, duplicate ownership, lost inbound, or stale-owner outcomes; signed artifact digest `a2db23a95530681953ffa3002ab14e349ebf53d19be2a54c1f4afacc3aead997`.

## Class-Closure Declaration

No agent-authored-artifact defect and no added or modified self-triggered controller — not applicable. The regression is nevertheless pinned at all three required test tiers by the evidence above.
