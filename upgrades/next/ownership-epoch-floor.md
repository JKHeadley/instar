# Ownership epoch floor — restarts no longer erase move evidence

## What Changed

The session-ownership registry is in-memory, so a server restart reset a quiet
topic's ownership epochs to 0 — while the coherence journal's (topic, epoch)
duplicate-detector is restart-PROOF. A deliberate move after a restart therefore
landed its ownership record (the transfer truthfully reported
`placedOwnership: true`) but its journal entries reused already-consumed epochs
and were silently deduped away: the durable evidence kept naming the PREVIOUS
machine as the topic's home (live-matrix finding #7, observed on v1.3.375).

`cas()` now consults an `epochFloorOf` seam — the newest JOURNALED epoch for
that session — so post-restart epochs continue monotonically and every landed
CAS journals under a fresh op-key. The in-memory store's fast-forward check
accepts any monotonic advance (like a git fast-forward, which may move several
commits). The floor is best-effort: a journal-reader failure reads as 0 and
never blocks an ownership CAS.

## What to Tell Your User

Nothing proactively — moving conversations between machines just stops losing
its paper trail when a server restarted in between.

- audience: agent-only
- maturity: stable

## Summary of New Capabilities

- `SessionOwnershipRegistry` gains an optional `epochFloorOf(sessionKey)` dep;
  the server wires it to the coherence journal's newest placement epoch.
- `applyOwnershipAction` accepts `ctx.epochFloor` (epoch = max(current, floor)).
- `InMemorySessionOwnershipStore.casWrite` accepts monotonic advance (>) rather
  than exactly +1 — same loser-rejection outcomes for stale candidates.

## Evidence

- `tests/unit/ownership-epoch-floor.test.ts` — 6 tests including the full
  regression: pre-restart epochs 1+2 journaled, registry wiped ("restart"),
  post-restart place+claim journal 3+4 instead of being deduped away; throwing
  floor never blocks a CAS.
- Existing `SessionOwnership.test.ts` + `SessionOwnershipRegistry.test.ts` +
  journal + transfer-route suites all green (62 blast-radius tests).
