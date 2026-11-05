# Conversation and Effort Hierarchy — Review Round 2

**Reviewed:** `conversation-effort-hierarchy-v1.md` on 2026-11-04. **Status:** architecture and product review in progress; DAWN's detailed feedback pending. Instar standards conformance checked 93 standards with zero possible violations. This is not a convergence verdict.

## Changes since Round 1

- Frozen the intended source-of-truth split: graph owns placement, InitiativeTracker owns linked work status, existing stores own transcript and routing, and viewer preferences own presentation.
- Added an append-only graph event contract, idempotency, version checks, deterministic replay, conflict visibility, and cycle quarantine.
- Specified the Conversations product flow in dashboard and app: overview, effort detail, transcript detail, flat inventory, search, provenance, move preview, and undo.
- Added provisional graph read/write API shapes and mobile permission parity.
- Corrected Slack identity: use the existing structured single-workspace tuple for v1 and plan a schema-versioned multi-workspace migration. A local numeric alias or normalized lookup string is not an immutable graph key.

## Findings requiring the next review round

1. **P1 — Cross-machine write authority.** The event schema is specified, but the implementation must identify an existing signed journal/replication seam and prove concurrent corrections converge to one conflict state. The draft cannot yet claim a chosen backing store is implementation-ready.
2. **P1 — Client compatibility and privacy.** Mobile hierarchy routes need exact auth parity with app, Telegram, and Slack conversation reads. A server must filter inaccessible nodes before child counts, pagination, search, and digest generation. This needs scenario tests with different people and machine ownership.
3. **P1 — Correction conflict UX.** A concurrent user move must not silently choose a winner. The user should see the last agreed path, the two proposed destinations, and one resolution action. Mobile offline correction queueing needs a clear retry/conflict contract.
4. **P2 — Inference data quality.** Topic memory may be sparse or truncated. Every suggestion and digest needs coverage and freshness in-band. Historical backfill should be suggestion-only until measured precision is high enough to earn automatic placement.
5. **P2 — Attention metrics.** The draft's 100-event burst scenario tests routine silence, but an exact ceiling for distinct decisions/results needs measurement from real topic traffic.
6. **P2 — Product prototype.** Deep-tree navigation and correction on a narrow phone still need a visual prototype and accessibility walk-through.
7. **External review — DAWN.** Initial brief delivered and acknowledged through Echo's awake relay; a focused follow-up was sent on 2026-11-04. Her substantive findings have not yet been incorporated.

## Next steps

Obtain DAWN's first-hand cases; compare exact current graph-capable storage options; turn provisional APIs into request/response examples; run independent architecture, UX, and privacy review; revise to a converged spec only after those findings are resolved. Preserve the current draft and review trail as evidence.
