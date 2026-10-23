## What Changed

The feature-maturation engine now reads the **real inventory of staged switches from the running
build** instead of only the handful whose spec remembered to register one, and every staged switch
gets a durable record carrying who owns it, when its trial window closes, and whether there is any
evidence it actually ran.

Before this, the engine watched a list that specs had to opt into: 3 tracked items out of 1,201.
Everything else — every feature shipped dark, every check left in trial mode — aged out of sight
with nothing bringing it back for a decision. That is how a trial can sit finished-but-undecided
for two months without anyone noticing.

Specifically:

- A new rule (R7) in the growth analyst treats every switch that is off-by-default, diverged from
  its default, or on-but-in-trial-mode as a first-class maturation subject, keyed on the switch
  itself rather than on a spec entry. It reads this through the **same** code path the guard-status
  surface uses, so the engine and what you can read can never disagree about what is dark.
- A durable record holds each switch's owner, deadline and proof-of-life. It is deliberately a
  plain JSON file on the existing file-based-state design — no new dependency.
- The deadline is anchored to when the switch was **first seen dark** and never moves after that.
  A switch that flickers on and off cannot keep resetting its own clock to escape review.
- Switches that were **already** dark when the record was first created are not handed a fresh
  clean window — that would hide exactly the forgotten backlog this exists to surface. They are
  recorded as overdue immediately and lead the first report.
- A switch that is renamed or removed leaves its history behind as a tombstone rather than
  vanishing from the record.
- A switch that is genuinely switched on is marked graduated, and the record keeps the exact state
  it left as rather than claiming more than it knows.
- Findings **aggregate**: one row per class carrying the count and the list, never one notification
  per switch. A 184-switch backlog is one line, not 184.
- The report now leads with the maturity signal. The "initiatives drifting" rule, which produced
  hundreds of work-item rows and no maturity signal at all, is moved to the tail — still computed,
  still shown, no longer crowding out the thing the report exists to carry.

This is increment 1 of a converged design from July that was only a quarter built; the delivery
part shipped and the three parts that make the engine see, remember and watch itself did not.

## What to Tell Your User

Nothing changes for you until you turn it on. This ships switched off, and switched off the
engine behaves exactly as it did before.

When you do turn it on, the honest description is: **it makes the forgotten pile visible and
remembers it across restarts. It does not yet decide anything for you.** Promotion is still your
call, and a switch with no evidence it ever ran can never be reported as ready — "no evidence" is
reported as unknown, never quietly treated as proof.

Turn it on in two stages, and in this order:

1. Set it enabled while leaving trial mode on. The record fills with real states and real
   deadlines, and nothing reaches your weekly report yet. Read the record directly.
2. Once the record looks right, clear trial mode. The findings then reach the report.

Expect the first live report to name a sizeable pile of switches with **no owner**. That is the
point, not a bug — an un-owned staged feature is the gap this closes. There is not yet a one-tap
promote / extend / retire surface for them; that is the next increment, and until it lands you act
on them through the paths you already have.

To turn it off at any time, set it back to disabled — no deploy needed, and the engine reverts
exactly. The record file is additive and read by nothing else; you can leave it or delete it,
though deleting it restarts every deadline from scratch.

On more than one machine this record is deliberately **per machine**, because whether a switch is
live genuinely differs per machine — the same switch really is in trial mode on a development
machine and fully dark on a fleet one. A record written by one machine is refused by another
rather than merged, so one machine's "already proved" can never leak into another's judgement.

## Summary of New Capabilities

- Every staged switch in the running build is now tracked automatically, whether or not anyone
  registered it — the engine's blind spot (3 of 1,201) is closed.
- Each tracked switch carries a durable owner, deadline and proof-of-life that survive restarts.
  A trial measured only in memory could never prove "N clean days"; this one can.
- Deadlines cannot be gamed by a flickering switch, and a pre-existing backlog cannot be hidden
  behind a fresh window.
- Removed or renamed switches keep their history instead of disappearing.
- Reports lead with feature maturity instead of work-item noise, and never scale their
  notification count with the size of the backlog.

## Evidence

- 102 new tests across all three tiers, all passing:
  - `tests/unit/DarkFlagMaturationRegistry.test.ts` (50) — the dark-set predicate on both sides of
    every state, proof honesty, monotonic deadlines under a 6-cycle on/off toggle,
    migration-is-not-a-clean-slate, tombstoning, graduation only on genuinely-on states, history
    appending only on real change, foreign/corrupt record handling, and stored-deadline consistency when a window widens or narrows.
  - `tests/unit/growth-analyst-darkflag-r7.test.ts` (36) — gating on both sides, the trial-mode
    canary (record written, no findings), aggregation verified at 120 switches, the
    never-report-ready-on-unknown rule, the demotion, every degrade-to-skipped path, wiring
    integrity against the real construction site, and a parity guard locking the two report
    surfaces together.
  - `tests/integration/growth-analyst-darkflag-routes.test.ts` (10) — over the real HTTP pipeline,
    including durability across a restart and tombstoning through the routes.
  - `tests/e2e/growth-darkflag-maturation-lifecycle.test.ts` (6) — a real server on a real port:
    the feature-is-alive assertion, the full overdue → graduate → flicker-back → tombstone
    lifecycle, and the refusal to adopt another machine's record.
- Three defects found and fixed before shipping, each now covered by a test:
  - The new rule reached the weekly report but not the findings route — the same "the rule lives
    in two places that disagree" defect the driving design names as a reason the engine stalled.
    Both are aligned now and a test holds them together.
  - The report text listed the affected switches by their internal names. That text goes straight
    into the weekly message, and internal names are exactly what the outbound check blocks — so
    the first live report would have been blocked, which is the very failure another part of this
    same design exists to prevent. The names now travel as structured data for the dashboard and
    the message carries plain words.
  - A switch's recorded deadline could drift away from the deadline actually being applied.
- Side-effects review: `upgrades/side-effects/maturation-darkflag-inventory.md`.
