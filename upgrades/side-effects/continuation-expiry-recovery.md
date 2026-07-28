# Side-Effects Review — continuation expiry recovery

**Version / slug:** `continuation-expiry-recovery`  
**Date:** `2026-07-17`  
**Author:** `Instar Agent (instar-codey)`  
**Second-pass reviewer:** `Echo`

## Summary of the change

Adds an authenticated, generation-ordered renewal primitive to `CodexTaskContinuationStore`, wires it through the continuation API and CLI, exposes bounded expiry in status, and fixes CLI auth resolution after token externalization. It touches the explicit operator authority that creates continuation generations but does not add automatic renewal.

## Decision-point inventory

- `CodexTaskContinuationStore.renew` — add — accepts an explicit authenticated request to mint a fresh bounded generation from a valid checklist with open work.
- continuation status expiry rendering — add — structural date validation controls whether `expiresAt` is an ISO timestamp or null.

## 1. Over-block

Renewal refuses malformed ledgers and ledgers with no open tasks. A legitimate but hand-corrupted ledger cannot be renewed through this path; that is intentional because adopting unaudited state would weaken operator-stop ordering. No message/content judgment is introduced.

## 2. Under-block

An authenticated caller may renew a stopped, expired, or still-live ledger and reset its clock/count. Post-stop/post-expiry revival is deliberately lower-friction than `start` because it retains the digest-verified checklist, but it mints above the tombstone with the same fresh authority as authenticated `start`; it does not adopt stale authority. Operators should use renew for expired or intentionally extended work. The audit's distinct `renewed` reason makes every such action visible.

## 3. Level-of-abstraction fit

The store is the correct layer: it already owns generation ordering, tombstones, locking, bounds, digest validation, and audit writes. Implementing renewal in the CLI or by editing the ledger would duplicate or bypass those invariants. The route remains a thin authenticated adapter.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no message/content judgment surface.

This is deterministic authority over a constrained state machine. Structural validity, open-task presence, generation ordering, and configured numeric bounds are enumerable invariants, not brittle semantic detectors.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Renewal is an explicit authenticated command; it does not infer whether work deserves renewal.

## 5. Interactions

- **Shadowing:** renewal uses the same maintenance→topic lock order and tombstone maximum as start. An explicit authenticated renewal intentionally mints `max(prior, topic stop, global stop) + 1`, so it is fresh authority that can restart previously stopped work; stale generations still cannot outrank the new stop or renewal.
- **Double-fire:** no automatic caller is added; duplicate explicit renew requests create successive audited generations, each bounded.
- **Races:** maintenance and topic locks serialize renew with start, stop-all, and decisions. A corrupt stop marker remains authoritative through the existing sentinel behavior.
- **Feedback loops:** none; status is read-only and renewal does not schedule itself.

## 6. External surfaces

The CLI gains `continuation renew`; the local API gains `POST /continuation/:topic/renew`; status adds `startedAt` and `expiresAt`. Persistent local ledger and audit state gain a fresh generation and a distinct `renewed` row. There are no external-service calls, generated URLs, or user notices. The action is conversationally phone-completable because the agent can execute it for the operator; no PIN-only human form is introduced.

## 6b. Operator-surface quality

No dashboard or form surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** ordinary-work continuation authority is owned by the specific Codex session and its machine-local Stop hook. The ledger is deliberately excluded from replication so a second machine cannot adopt and continue the same session implicitly. Renewal must be executed against the machine serving that topic/session. It emits no notices, generates no URLs, and its durable state does not claim to follow topic transfer; a transfer requires a fresh explicit generation on the destination.

## 8. Rollback cost

Revert and ship a patch. Existing version-1 ledgers remain readable; the new route/CLI simply disappear. A ledger renewed while the feature was present remains a normal valid generation. No migration or state repair is required.

## Conclusion

The review preserved the bounded safety model and replaced manual state mutation with the existing store's authority. Echo's review prompted a distinct renewal audit reason and corrupt-date fail-safe. The change is clear to ship after the second-pass artifact review and green CI.

## Second-pass review

**Reviewer:** Echo  
**Independent read of the artifact:** concur — after correcting the first draft's stop-tombstone wording, the reviewer confirmed the artifact accurately characterizes renewal as explicit fresh authority and covers the boundedness, race, audit, and machine-local risks.

## Evidence pointers

- `tests/unit/CodexTaskContinuationStore.test.ts`
- `tests/integration/autonomous-sessions-api.test.ts`
- Live topic-458 audit row at `2026-07-18T02:33:11.364Z` records the reproduced `duration-expired` stop.

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered controller was added or modified — not applicable.
