# Side-effects review — census pending-tracker adjudication

**Change:** `GET /decision-quality` stops reporting a peer-minted tracking action as a
dead tracker. `censusDebt` gains a second bucket, `pendingRefUnverifiable`.

## What actually changed

`readLiveEvolutionActs()` now returns `{ alive, highWater }` instead of a bare
`Set`, where `highWater` is the largest `ACT-NNNN` ordinal the local queue has ever
held (terminal rows included — a completed action still proves this machine minted
that far). A new pure exported function `adjudicatePendingTracker()` maps one
tracker to `alive | dead | unverifiable`.

## Why (the defect)

`PROVENANCE_COVERAGE` declares each pending decision point's tracker as a **shipped
source constant** — `pending:ACT-1193` on all 49 entries, byte-identical on every
install. That constant was validated against the **machine-local, unreplicated**
evolution action queue.

Measured 2026-07-23 on the live pool:

| machine | actions | max id | `ACT-1193` | `pendingRefDead` |
|---|---|---|---|---|
| Laptop | 1211 | ACT-1211 | present, `pending` | (queue path absent ⇒ check skipped) |
| Mac Mini | 1063 | ACT-1119 | **absent** | **49 entries flagged** |

Nothing had been deleted. The Mini had simply never minted an id that high. The two
queues cannot converge: `multiMachine.stateSync.evolutionActions` has a wired send
side but its journal-apply side is an explicitly unbuilt later rollout stage
(`server.ts`: *"With only the own origin the union is a strict no-op"*).

So this was a **false alarm by construction**, and it would fire on every machine
added to a pool, forever.

## Blast radius

- **Surface:** one read-only observability route. `GET /decision-quality`.
- **Authority:** none. `censusDebt` gates nothing, blocks nothing, and drives no
  automated action. It is a number a human reads.
- **Write paths:** none touched. No store, no migration, no config key.
- **Other consumers of `readLiveEvolutionActs`:** none — `grep` confirms a single
  callsite. The return-type change is contained to that one block.

## Risk analysis

**The signal this check exists to give is preserved.** A tracker within the range
this machine has minted, but absent or terminal, still reports `dead`. That is the
genuine "the plan lost its tracker" case and it is unit-pinned on both sides of the
boundary (`ACT-1119` at high-water 1119 ⇒ dead; `ACT-1120` at high-water 1119 ⇒
unverifiable).

**Could this hide a real deletion?** Only if the deleted action's id were *above*
every id the local queue retains. That requires deleting the highest-numbered action
AND every action minted after it — at which point the local queue genuinely has no
evidence the id ever existed here, and "unverifiable" is the honest answer rather
than a guess. The bucket is surfaced, not suppressed, so a human still sees it.

**Fail-safe direction unchanged.** An absent or unreadable queue still yields
`null` ⇒ neither bucket ⇒ a fresh agent is never false-flagged. Preserved and
re-pinned by test.

**Unparseable ids keep the strict reading.** A malformed tracker (`ACT-oops`,
`CMT-1193`) reports `dead` rather than disappearing into the unverifiable bucket —
a malformed constant is a real defect and must stay loud.

## API compatibility

`censusDebt.pendingRefDead` keeps its name, type, and meaning; it only stops
carrying false entries. `pendingRefUnverifiable` is **additive**. Any consumer
reading the old field keeps working; a consumer that treated a non-empty
`pendingRefDead` as an alarm will now (correctly) see it empty on non-origin
machines.

No dashboard or job reads this field today (`grep` across `src/` and
`src/scaffold/templates/jobs/` returns no consumer), so there is no downstream
render to update.

## Migration parity

None required. This is server-side route logic with no installed-file, config, hook,
skill, or CLAUDE.md-template surface. Existing agents pick it up with the normal
version bump — there is no per-agent state to migrate and no default to backfill.

## Testing

- **Unit** (`tests/unit/pending-tracker-adjudication.test.ts`, 8 tests): both sides
  of every boundary — alive/dead/unverifiable, the `>` vs `>=` high-water edge,
  terminal-is-not-alive, unparseable-stays-strict, empty-queue.
- **Integration** (`tests/integration/decision-quality-routes.test.ts`, +5 tests):
  the real Express route + auth middleware over a real on-disk queue fixture,
  asserting each bucket through the actual HTTP response.
- **E2E** (`tests/e2e/decision-quality-alive.test.ts`): both buckets present in the
  live shape on the production initialization path.

26 tests green across the three files; `tsc --noEmit` clean on every touched file.

## Rollback

Revert the commit. The route returns to today's behaviour; nothing persists, so
there is no data to unwind.
