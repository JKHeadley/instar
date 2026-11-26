# Side-Effects Review — Codex account-aware Telegram follow-ups

**Version / slug:** codex-pooled-telegram-followup
**Date:** 2026-11-23
**Author:** echo
**Second-pass reviewer:** codex_followup_review, read-only concurrence including corrected authentication fixture

## Summary of the change
Tier1 SMALL reversible fix to the default Codex rollout-baseline resolver. The existing physical-effect journal stays authoritative; no new queue, schema, authorization or replay mechanism is added. Nine source/test/doc files; 28 runtime lines plus one awareness sentence. One independent reviewer, one short plan, no spec-convergence claim; normal commit gate required.

## Decision-point inventory
- Transcript baseline location: modify; read the actual session CODEX_HOME rather than always the default home.
- Stage-B acceptance, ownership fence, capacity breaker, FIFO and physical lock: pass-through, unchanged.
- Injected resolver seam: unchanged; tests/custom construction can provide an explicit resolver.

## 1. Over-block
A missing or unreadable account transcript still cannot authorize physical delivery. Unexpected tmux query failures and malformed account values must not silently substitute a different account. Previously valid default-home conversations retain documented missing/unset defaults. No message-content filter is added.

## 2. Under-block
Native UUID collision across unrelated account folders cannot select the default transcript when an explicit home is present. This fix does not establish that every busy-pane failure is solved, recover historical refused messages, or alter deduplication. A separate existing early Telegram message-ID cache insertion can falsely acknowledge a retry after failure; record separately, do not claim it repaired here.

## 3. Level-of-abstraction fit
The shared SessionManager baseline resolver serves initial dispatch, durable prepared-row drain and observer; correcting its location input fixes these consumers together. No Telegram-only bypass or alternative terminal writer is added.

## 4. Signal vs authority compliance
No new blocking authority. The account path is evidence supplied to the existing journal’s exact generation and baseline checks. Existing deterministic ownership, integrity and exactly-once physical-effect floors remain unchanged. Reference: docs/signal-vs-authority.md.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. The runtime environment and exact session UUID determine an enumerable transcript location; this is not a content or urgency judgment.

## 5. Interactions
Shadowing: resolves before existing baseline binding and leaves its checks intact.
Double-fire: no new injection/retry loop. Prepared rows remain blocked by their active predecessor.
Races: account env is read for the exact incarnation; native UUID/path binding and owner epoch still fence dispatch. No cached home across restart.
Feedback loops: observer reads the same resolver, not a separately selected account.

## 6. External surfaces
Pooled Codex owner Telegram sends stop failing solely due to wrong-home lookup. No external API/settings are added. SQLite format and custody rules are unchanged. Tests use private temporary state, transcripts and an executable terminal-environment fixture; no live user-message injection, account authentication file, replay, session restart or installed helper modification. The fix requires the usual reviewed update; no live success claim.
Operator surface: sending a follow-up remains available from the existing Telegram conversation and app; no new operator action.

## 7. Rollback
Ordinary source revert. No schema/config migration, data deletion or replay. Retain evidence of uncertain deliveries; do not blindly repeat them during rollback. Full gate/release remains Chief and throughput custody.

## 8. Multi-machine posture
**machine-local BY DESIGN**: a session’s running account home and transcript path belong to its owning machine. Existing lease, transfer and incarnation fences remain responsible for cross-machine delivery; a path from another machine never grants local dispatch authority.

## Verification
Actual baseline: one expected path-resolution failure, two passes, zero skips. GREEN unit10/10 passed. First HTTP fixture failed401 because its real lifeline secret was missing; the sequence stopped and the failure was preserved. Fixture-only header correction independently reviewed; other eight hashes unchanged. Fresh authorized pair: HTTP1/1 and lifecycle1/1 passed, zero skips, exit0. Build exit0. Lifecycle simulates predecessor completion through the real ledger and proves persistence/drain, not actual Codex consumption. Independent review concurred. Normal commit hooks required; complete exact-head verification remains throughput custody and is not claimed.
