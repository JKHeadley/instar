# Convergence Report — Threadline Conversation Keystone (Phase 1)

**Spec:** docs/specs/THREADLINE-CONVERSATION-KEYSTONE-SPEC.md
**Date:** 2026-05-24 · **Iterations:** 1 (draft → reviewed → revised)
**Mode:** two parallel reviewers (completeness/correctness + adversarial/risk),
grounded against the live code (ThreadlineRouter, ThreadResumeMap, ContextThreadMap,
ListenerSessionManager, PipeSessionSpawner, server.ts relay inbound funnel,
CommitmentTracker).

## Verdict on the first draft: NOT approvable. Two fatal issues + four blocking.

| # | Severity | Finding | Resolution in revised spec |
|---|----------|---------|----------------------------|
| 1 | FATAL | Loop gate placed in `handleInboundMessage`, but the ack-loop rides the pipe-spawn + warm-listener branches that bypass it (server.ts:6964+). Gate would never fire on the real loop. | Gate moved to the single inbound funnel upstream of all 3 branches; verdict short-circuits each (§3). |
| 2 | FATAL | Conversation inherits `ThreadResumeMap`'s no-CAS load→mutate→persist → concurrent inbound clobber turnCount/hashes → budget silently defeated. | Single-writer CAS per threadId, modeled on `CommitmentTracker.mutate()` (§1). |
| 3 | BLOCKING | Field list drops live data: `sessionUuid` (resume primitive!), `agentIdentity` (hijack guard), `pinned`, `messageCount`, `failed`/`archived` states, cross-machine fields. | Exhaustive field list + per-index TTL policy (§1). |
| 4 | BLOCKING | "No caller stamping" unachievable — relay-send HTTP has no session identity. | `INSTAR_SESSION_NAME` injected at spawn, forwarded by the MCP server, resolved at the route (§2). |
| 5 | SECURITY | Resume-into-owner guard would let an unverified `plaintext-tofu` peer who guesses a threadId hijack a victim's owned session. | Guard gated to `verified` peers only; unverified falls to trust-gated first-contact (§2). |
| 6 | RISK | Cold-start re-loop: budget novelty-gated with no turn-1 history → first exchange unbounded. | Budget counts from turn 1 with conservative default (§3). |
| 7 | RISK | Novelty hash defeated both ways; short-but-decisive "yes/proceed/done" wrongly suppressed; `humanInLoop` forgeable. | Novelty function defined (hash=signal, Haiku=authority); control-token carve-out; `humanInLoop` derived only from instar's own verified-human records, unforgeable (§3). |
| 8 | RISK | Migration: ephemeral affinity lost on restart; index-disagreement could drop a binding. | Ephemeral affinity = accepted loss; reconciliation rule (resume entry authoritative); dual-read transition window (Migration parity). |

## Outcome

All fatal + blocking findings incorporated into the spec. Acceptance criteria
extended to test each (funnel placement across all 3 branches; CAS race; verified
guard; cold-start; migration field preservation). Ready for operator approval;
the `approved: true` tag is the operator's to apply.
