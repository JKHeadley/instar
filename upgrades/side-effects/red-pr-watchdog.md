# Side-Effects Review — Red-PR Watchdog

**Version / slug:** `red-pr-watchdog`
**Date:** `2026-07-09`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `Echo (self, second pass)`

## Summary of the change

A signal-only watchdog on the existing green-PR auto-merge watcher tick. After the merge
logic runs, `redPrWatchdogPass` sweeps my own open PRs and raises ONE deduped,
age-escalating attention line for any PR with a required check stuck RED past a threshold
(default 2h). Files touched: `src/monitoring/greenPrLogic.ts` (new pure helpers
`latestRunPerCheck` / `failingChecksFromRollup` / `stuckRedChecks`, a `failingChecks` field
on `PrSummary`, and a correctness fix to `deriveRollup`), `src/monitoring/greenPrAutomergeWiring.ts`
(`mapPr` populates `failingChecks`; `deriveRollup` dedups first), `src/monitoring/GreenPrAutoMerger.ts`
(the pass + `redPrRaised` state memory + the `redPrWatchdogView` read + config),
`src/server/routes.ts` (GET fields), `src/config/ConfigDefaults.ts`, `src/core/types.ts`,
`src/commands/server.ts` (defaults/type/wiring). It is a DETECTOR only — it never merges,
closes, arms, or blocks.

## Decision-point inventory

- `redPrWatchdogPass` (GreenPrAutoMerger.tick) — **add** — decides whether to RAISE an
  attention line for a stuck-red self-authored PR. Signal-only; no blocking/merge authority.
- `deriveRollup` (greenPrAutomergeWiring) — **modify** — the SUCCESS/PENDING/FAILURE verdict
  now dedups to the latest run per check first. This IS consumed by the merge candidate
  gate (`classifyCandidate` reads `statusRollup`), so the change is a correctness improvement
  to an existing authority's input, not a new authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The watchdog has no block/allow surface — it only raises attention, so it cannot over-block
a message or a merge. The one behavior it could over-*alert* on is a genuinely-red PR that
the operator already knows about; that is bounded to ONE deduped line per PR and clears on
recovery, so the cost is a single ignorable heads-up. The `deriveRollup` fix makes the merge
gate LESS restrictive (a re-run-green PR that previously read FAILURE now reads SUCCESS) —
this is the correct direction; safe-merge re-verifies at act time, so a misread here can only
cause a refusal, never an unintended merge.

## 2. Under-block

**What failure modes does this still miss?**

- A failing check with an unknown `completedAt` (0) is deliberately NOT flagged — we cannot
  prove it has been red long enough, so we fail toward silence. A rollup shape that never
  carries a completed time would therefore never alert. Acceptable: the common case (GitHub
  Actions CheckRun) always carries `completedAt`.
- A PR that is red because it is *unmergeable* (conflicts) rather than a failed check is not
  the watchdog's target — it watches failing checks, not merge conflicts. That is a separate
  signal the merger already skips on.
- A PR authored by me but on a branch outside my namespace is skipped (the author proxy is
  the branch-namespace filter, since `listOpenPrs` already passes `--author @me`).

## 3. Level-of-abstraction fit

Right layer. The green-PR watcher already enumerates my open PRs with their check status
every tick; the watchdog rides that existing loop and reuses the already-fetched rollup — no
new gh call, no parallel poller. It feeds the existing attention-queue coalescing rather than
inventing a new notification surface. A higher layer (a generic PR monitor) would duplicate
the enumeration; a lower layer (the pure helpers) is where the check-dedup logic correctly
lives and is unit-tested.

## 4. Signal vs authority compliance

Compliant. Per `docs/signal-vs-authority.md`, the watchdog is a pure SIGNAL producer: its
only effect is `refreshAggregate` → an attention line. It holds NO blocking authority — it
cannot merge, close, arm, disarm, or block a message. The brittle part (heuristic "is this
check stuck red") is confined to the signal; no authority is gated on it. The `deriveRollup`
change improves an existing detector's accuracy; it does not add a new authority.

## 5. Interactions

- Runs AFTER the merge logic and the Layer-2 snapshot in the same tick, so it never shadows
  or races the merge path. It only reads `candidates` (already gathered) and writes its own
  `redPrRaised` state slice + the shared `attentionLines` set.
- Shares the aggregated attention item (`green-pr-automerge:aggregate`) with the merger's
  other lines; the P17 attention coalescing dedups the ITEM, and the `redPrRaised` memory
  dedups the LINE, so the two dedup layers stack rather than fight.
- The `deriveRollup` fix is consumed by `classifyCandidate` (settled-green gate) — verified
  no other consumer exists (grep: `deriveRollup` is used only in `mapPr`). Single-run rollups
  are unchanged, so existing green/pending/failure classification is byte-identical.
- No double-fire: the watchdog runs once per tick; a busy/disabled/breaker-open/list-failed
  tick returns before it, so it never runs on stale data.

## 6. External surfaces

Adds two fields to `GET /green-pr-automerge` (`stuckRed`, `redPrWatchdog`) — additive, no
removed fields, no breaking change to existing consumers. Raises attention lines visible to
the operator (the intended surface). No change visible to other agents or peers. It depends
on the green-PR watcher's tick cadence and the gh rollup shape, both already in use.

## 6b. Operator-surface quality

No operator-surface file (no `dashboard/*` renderer, approval page, or grant/secret form) is
touched — the only operator-visible output is a plain-English attention line and a JSON read
field, both already-established surfaces. Operator-surface quality: the attention line leads
with the action ("PR #N red for Xh — <checks>"), exposes no raw internals, and reads at phone
width. No raw technical input is ever requested from the operator.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, inheriting the parent green-PR watcher's posture exactly. The
green-PR watcher's state (`state/green-pr-automerge.json`) is per-machine and lease-gated —
ticks run only on the lease holder. The `redPrRaised` memory lives in that same per-machine
state file and is therefore never replicated; the watchdog only runs on the machine holding
the serving lease, so there is no double-alert across machines. The attention item it raises
is one-voice by construction (the shared `green-pr-automerge:aggregate` id + P17 coalescing).
No durable state strands on topic transfer (it is watcher-state, not topic-state), and it
generates no cross-machine URLs. This matches how green-pr-automerge already behaves.

## 8. Rollback cost

Cheap. Revert the PR — the watchdog is signal-only, so there is no data migration and no agent
state to repair (the `redPrRaised` slice is ignored by older code and re-derived each tick).
Softer levers without a revert: set `monitoring.greenPrAutoMerge.redPrWatchdog.enabled: false`
to turn just the watchdog off, or raise `redThresholdMs`. The `deriveRollup` fix is the only
behavioral change to an existing path; if it were ever wrong it would make the merger MORE
conservative (skip), never over-merge — safe-merge remains the act-time authority.

## Self-action note

`unbounded-self-action`: n/a — the watchdog performs no self-triggered control action (no
restart / respawn / spawn / kill / swap / retry / re-drive). Its only effect is raising an
attention line, and that is bounded by the per-PR `redPrRaised` dedup memory (ONE line per
stuck PR, re-raised only on age-escalation, cleared on recovery) — so it converges under
sustained pressure rather than emitting unboundedly.
