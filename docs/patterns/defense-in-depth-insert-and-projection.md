# Pattern — Insert-Time + Projection-Time Defense-in-Depth

**Status:** pattern doc · cherry-picked from the GSD-Instar integration spike (2026-05-23)

## The pattern

When a constraint can be enforced at more than one layer, enforce it at both — the cheap deterministic layer AND the authoritative computed layer. A single-layer guarantee silently degrades when the un-guarded layer is reached by a path you didn't anticipate.

The canonical shape:

- **Insert-time check** — runs when data enters the system. Cheap, local, catches the common case immediately, and keeps bad data from accumulating.
- **Projection/read-time check** — runs when the truth is computed from accumulated data. Authoritative, sees the whole picture, and is the final word.

Neither alone is sufficient:

- Insert-time alone misses anything that arrives through a path that skips the insert guard (a migration, a backfill, a second writer, a future caller).
- Projection-time alone lets bad data pile up in storage and pay the recompute cost on every read; it also can't stop a caller that reads raw storage instead of going through the projection.

## Worked example — the Topic Intent Layer affirmation cap

The Topic Intent Layer (Layer 1) caps how much a single user affirmation can raise confidence in a tracked decision: one affirmation bonus per refId per 24h.

- **Projection-time** (`projectConfidence`): when computing confidence on read, the projection groups affirmation events by day and counts only the first per 24h window. This is the authoritative cap — even if extra affirmation events exist in storage, the computed confidence respects the limit.
- **Insert-time** (the extractor / the path that appends evidence): SHOULD also refuse to append a second affirmation event for the same refId within 24h. This keeps the event log clean, makes the projection cheaper, and — critically — defends the invariant even if some future caller computes confidence by a different path or reads a partial projection.

The spike's gsd-executor methodology pass flagged that the Topic Intent Layer shipped with the projection-time cap only. That's correct and authoritative for the confidence value, but it leaves the event log able to accumulate redundant affirmation events, and it assumes every confidence read goes through the one projection function. Adding the insert-time cap closes both gaps. (Tracked as a Layer 1 follow-up.)

## When to apply

Reach for this pattern whenever:

- A cap, quota, or invariant is computed from accumulated state (event logs, counters, ledgers).
- More than one code path can write the underlying data.
- The constraint protects against a corruption-class failure (silent authority laundering, quota bypass, unbounded growth).

## When NOT to apply

- The constraint is purely cosmetic or easily recovered — one layer is fine.
- There is genuinely a single, guaranteed-sole write path AND a single read path — though "guaranteed sole" is a strong claim that tends to erode as the system grows, so bias toward both layers when the cost is low.

## Relationship to signal-vs-authority

This is compatible with `docs/signal-vs-authority.md`, not in tension with it. The insert-time check is a low-context SIGNAL/filter; the projection-time check is the AUTHORITY. Defense-in-depth says: run the cheap signal early AND keep the authoritative computation as the final word. The signal never overrides the authority — it just stops the common case before it accumulates.
