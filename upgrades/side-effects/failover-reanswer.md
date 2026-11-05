# Side-Effects Review — cross-machine failover reanswer

**Version / slug:** `failover-reanswer`
**Date:** `2026-11-04`
**Author:** `Echo`
**Second-pass reviewer:** independent reviewer agent
**Tier and effort:** Tier 1, a reversible incident fix across 16 source, test, and documentation files (roughly 350 added lines). One independent review pass and one planned commit/gate attempt. The loopback repair route is restricted to an already answered row, with an exact reply and an audit record.

## Summary of the change

The forwarded owner claims the router's original inbound key, so a genuine reply produces a cross-machine completion marker. Stuck recovery reads pooled topic history before replay and holds a row when a prior owner's history is unavailable. Cold and forwarded topic spawns include pooled history or a plain incomplete-history warning. Changes touch the ledger, recovery, topic context, server wiring, and focused tests. A Bearer-authenticated loopback reconciliation route settles legacy rows only after its caller attests to reviewing an exact reply found in pooled history.

## Decision-point inventory

- Forwarded owner claim: modified; the owner links its reply to the original inbound key.
- Stuck recovery: modified; pooled reply evidence or uncertain history holds a row until an exact owner marker or verified reconciliation arrives.
- New session context: modified; pool history and incompleteness warning are supplied on transfer.
- Maintainer reconciliation: added; an exact reviewed reply can settle a legacy processing row. Its machine-local write domain is declared with a per-machine ledger and audit story.

## 1. Over-block

An unanswered message may wait while a past owner cannot be reached or a journal placement is unreadable. This is visible in the recovery log and leaves the row processing for another sweep. It avoids a duplicate answer during transient link loss.

## 2. Under-block

A generic later outbound message in the same topic can look like reply evidence even if it did not answer the original question. This follows the existing topic-since-receipt ledger semantics. The original message must be present in the pooled history; a missing message never authorizes replay.

## 3. Level-of-abstraction fit

The ledger owns message completion; recovery owns replay. WriteDomainRegistry classifies the new repair route as machine-local because it settles this machine's own inbound row and audit file. Pooled history is evidence supplied to the existing recovery decision, not a separate dispatch decision. The session context layer owns the warning presented to the agent.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the pooled history check is a signal consumed by the existing recovery gate; it cannot terminally settle a row.

The historical reply check supplies answered, unanswered, or unknown evidence to the existing recovery authority. A possible answer or unknown history only holds the row. Only the exact inbound reply marker can settle it automatically. The full topic excerpt is supplied to the session for conversational judgment.

## 4b. Judgment-point check (Judgment Within Floors standard)

The deterministic floor is that a previous owner must be checked before replay. Whether a later message semantically answered the user still needs session judgment; the existing topic-level reply marker semantics are unchanged.

## 5. Interactions

The owner reply marker can close the router row before the recovery sweep. If the marker is lost, pooled history holds it for verified reconciliation. The sweep checks reply evidence before skipping a reachable foreign owner, allowing old answered rows to be held for reconciliation. Concurrent sweeps are serialized by a local in-progress flag.

## 6. External surfaces

A Bearer-authenticated, loopback-only `POST /telegram/reconcile-stuck-ledger` route is added for maintainer reconciliation of legacy rows. It requires the exact inbound and specified agent reply in pooled history, plus a caller-supplied `reviewedBy: echo` attestation. The attestation is audited but does not authenticate a human identity. Existing cold-start prompts include pooled history or warn that it may be incomplete. Recovery may delay an unanswered turn until a former owner can be checked.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The route names the exact reply being used and returns the resulting ledger state. The warning states what information may be missing and tells the session to check pooled history before making an unanswered claim. Recovery logs explicitly state when an uncertain row is held.

## 7. Multi-machine posture (Cross-Machine Coherence)

Reply completion is replicated by the existing reply marker transport. The fallback is a read of pooled Telegram history, checked against the coherence journal's prior owner placements. If a previous owner cannot be queried, or an unlinked later outbound appears, the row remains open and is not replayed. The history warning accompanies topic transfer.

## 8. Rollback cost

Revert the source change and redeploy. No schema migration or one-way state change is introduced. Rows settled from verified history remain terminal, matching the already answered state.

## Conclusion

The owner commit path uses the exact inbound key; recovery treats pooled history as a hold signal, not a terminal completion marker. A maintainer can settle a legacy row with a specified, reviewed reply. The main tradeoff is delayed recovery during an unverified peer outage. The reconciliation route requires a maintainer to choose the reply, since topic-level chronology cannot prove semantic relevance.

## Second-pass review (if required)

First pass raised concerns about weak terminal settlement, missing positive peer-read proof, and the live test scope. Those were fixed. Final reviewer verdict: "I concur with the revised fix. The self-only placement case is handled and tested, and I found no remaining code blocker."

## Evidence pointers

- `tests/unit/stuck-message-recovery.test.ts`
- `tests/unit/ForwardedTopicContext.test.ts`
- `tests/e2e/sessionpool-failover-two-node.test.ts`
- `logs/server.log` incident entries for telegram:136471:136473
- `/coherence/journal?topic=136471` and pooled topic history

## Class-Closure Declaration (display-only mirror)

All observed replay and takeover paths in this incident are addressed by the owner marker, pooled history check, and incomplete-history warning.
