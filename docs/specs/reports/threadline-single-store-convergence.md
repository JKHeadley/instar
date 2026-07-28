# Convergence Report — Threadline Single-Store Collapse (Phase 2a / CMT-497)

**Spec:** docs/specs/THREADLINE-SINGLE-STORE-SPEC.md
**Date:** 2026-05-24 · **Iterations:** 1 (draft → reviewed → revised, approach pivot)
**Mode:** two parallel reviewers (completeness/correctness + adversarial/risk),
grounded against the live code at v1.2.68.

## Verdict on the first draft: NOT approvable. Approach pivoted.

The first draft proposed making the server the single writer via four new
`/threadline/conversations/*` HTTP endpoints, with the MCP stdio child routing its
thread-state access through them. Both reviewers rejected it.

| # | Severity | Finding | Resolution in revised spec |
|---|----------|---------|----------------------------|
| 1 | FATAL | The file-backed `ContextThreadMap` AND its only consumers (`A2AGateway`, `OpenClawBridge`) are never constructed in production — dead code. §4's ContextThreadMap-view work targeted a non-live path. | ContextThreadMap removed from scope entirely; documented as dead-code path. Scope shrinks to the one live legacy store (`ThreadResumeMap`). |
| 2 | FATAL | The resume primitive's `uuid`/`sessionName` fields have NO documented bridge to `Conversation.sessionUuid`/`boundSessionName` (nor `lastAccessedAt`→`lastActivityAt`). A builder following the spec literally would lose `--resume`. | Exhaustive field-bridge table added (§2); acceptance #2 asserts every field round-trips. |
| 3 | BLOCKING | `/threadline/*` routes BYPASS the bearer middleware (`middleware.ts:123-126`); existing handlers self-auth or don't. New endpoints would have shipped UNAUTHENTICATED — any co-located process could read participants/session-UUIDs and call DELETE. | Approach pivot removes the HTTP surface entirely — no new endpoints, no auth gap. |
| 4 | BLOCKING (recommendation) | The HTTP surface is a heavy lever for eliminating ONE `.remove()` call, and adds latency + a silent-empty MCP failure mode + restart-window mutation loss (no durable retry like PendingRelayStore). Recommended a file-level version-CAS on `ConversationStore` instead. | Adopted. `ConversationStore` becomes reload-per-op + version-CAS + atomic-rename (cross-process safe), the legacy maps' proven pattern hardened with a version token. The MCP child keeps the `ThreadResumeMap` view, now file-CAS-safe — no HTTP, no auth gap, no restart-window loss. |
| 5 | BLOCKING | `ThreadlineObservability` raw-reads `thread-resume-map.json` (bypasses the class) → would show frozen/stale state after the file is retired. | §3 re-points Observability at `ConversationStore`. |
| 6 | RISK | Legacy `save` carries only resume fields; backing it onto a Conversation that also holds gate `turnCount`/`lastInboundHash` could clobber turn state if `save` replaces the record. | §2: `save` MUST MERGE via `mutateSync`, leaving turn/novelty fields intact; acceptance #3. |
| 7 | RISK | `mutateSync` version-bump is load-bearing for the async CAS to detect a racing sync write; only implied in the first draft. | Stated as an explicit invariant; acceptance #5 asserts a sync write racing an async increment loses neither. |
| 8 | RISK | `migrateFrom`/`getMigratedEntries`/`refreshResumeMappings`/`pin`/`unpin` have no live src/ callers — the view-preserves-signatures tests give false confidence about live paths. | §2 enumerates them, reimplements + tests for parity, and flags them as not-on-a-live-path. |
| 9 | RISK | Dual-read window could re-introduce a second writer if an older MCP child still file-writes during a partial fleet upgrade. | Dual-read is in-server read-only; the second-writer case is scoped to partial fleet upgrade and reconciled on next boot (documented accepted). |

## Outcome

Approach changed from HTTP-single-writer to file-level version-CAS; scope reduced
(ContextThreadMap dropped). All fatal/blocking findings incorporated. Ready for
operator approval; the `approved: true` tag is the operator's to apply.

## Note

This is the convergence process working as intended: grounded review against the
live code caught that the original approach (a) targeted dead code, (b) would have
shipped an auth hole, and (c) was over-engineered for a one-call write surface —
before any code was written. Mirrors the Phase 1 keystone convergence (which caught
2 fatal bugs pre-code).
