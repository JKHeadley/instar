# Side-Effects Review — OwnershipApplier mesh-self ordering fix

**Slug:** ownership-applier-meshself-ordering-fix
**Spec:** docs/specs/ownership-applier-meshself-ordering-fix.md
**Parent principle:** Wiring Integrity — a dependency-injected component must actually run, not be a silently-skipped no-op.

## What changed

A boot-ordering bug in `src/commands/server.ts` meant the transfer-fix §7.2 `OwnershipApplier`
was never constructed or ticked at runtime (its guard read `_meshSelfId` ~650 lines before
the boot sequence assigns it, so the guard was always false). Result: a topic transferred
between machines was recorded on the SOURCE and replicated to the DESTINATION's journal, but
the destination never materialized ownership → it never knew it owned the session → the seat
died on arrival. Caught by applying the Live-User-Channel Proof gold standard to a real
Laptop→Mini transfer.

Fix (order-independent — Structure > Willpower):
- `src/core/OwnershipApplier.ts` — `selfMachineId` accepts a late-bound getter (label-only;
  materialization never needs it); resolved per-tick instead of captured stale at construction.
- `src/core/ownershipApplierWiring.ts` (new) — `wireOwnershipApplier()` factory gates
  construction on the durable store ALONE (the correct condition), extracted so the invariant
  is unit-testable (the inline condition was untestable, which is how the bug shipped).
- `src/commands/server.ts` — calls the factory in place of the inline guard.

## Blast radius

- **Multi-machine destinations (the target):** a transferred seat now materializes durable
  ownership on the destination and is served there. This was BROKEN before — net improvement.
- **Single machine:** the durable store may be active but there are no peer placements; the
  applier ticks and finds nothing — a harmless no-op. No behavior change.
- **Transfer SOURCE:** unchanged (it writes ownership directly via the tclaim path).
- **No new route, config flag, state schema, URL, or migration.** Pure internal wiring +
  one new internal module (no agent-facing surface → no CLAUDE.md template change required).
- **Backward compatibility:** `OwnershipApplier`'s `selfMachineId` still accepts a plain
  string; all existing callers/tests are unaffected (7 existing applier tests stay green).

## Reversibility

No flag (it only activates the durable-ownership path that already ships pool-consistent for
replication-on pools / dark for single-machine). Revertable by reverting the three-file diff;
no durable state is written that would outlive a revert (ownership records are re-derived from
the replicated journal on the next tick).

## Risk / monitoring

Low. The applier is off the hot path (boot tick + 15s interval), never throws (degrades to
"materialized fewer this tick"), and fast-forward-CAS guards against clobbering a fresher
local decision. Observable via `[ownership-applier] materialized …` / `[OwnershipApplier]
materialized N/M …` in `logs/server.log` — their appearance is itself the proof the wiring is
now alive (the bug's signature was their total absence). Release gate: the live two-machine
re-run (deploy both → transfer → assert destination materializes + a reply serves from the
destination).
