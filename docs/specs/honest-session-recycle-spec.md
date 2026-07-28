---
title: Honest Session Recycle — stop dressing an autonomous-run recycle as a death
status: draft
parent-principle: "Honest progress messaging — a routine kill-to-respawn must not read to the user as a terminal failure (HONEST-PROGRESS-MESSAGING-SPEC lineage)."
eli16-overview: docs/specs/honest-session-recycle-spec.eli16.md
---

# Honest Session Recycle

## Problem (observed, topic 13481, 2026-06-14)

A long autonomous run's tmux session is capped at `session.maxDurationMinutes`
(default `DEFAULT_MAX_DURATION_MINUTES = 240`, +20%/max-60m buffer). The
age-limit block in `SessionManager.runMaintenanceTick` defers the kill while the
session shows active work (procs OR recently-grown transcript), but reaps it the
moment it is **idle between turns** past the cap, via:

```
terminateSession(session.id, 'age-limit', { finalStatus: 'killed', disposition: 'terminal' })
```

`ReapNotifier` maps `age-limit → "it reached its maximum allowed runtime"` and,
because `disposition: 'terminal'`, emits the user-facing
`🪦 Your session … was shut down — it reached its maximum allowed runtime`.

Meanwhile the **autonomous run** is a *separate* clock (`durationSeconds`, e.g.
86400). `/session/clock` for the same topic reported **11h 42m remaining (51%)**
at the exact moment the gravestone fired. Two clocks, contradictory user-facing
claims. No work was lost (`midWork:false`, work on disk/merged, run record stays
`active`, the session respawned ~31m later on the next inbound message). The
harm is purely experiential: a routine recycle reads as repeated death, which is
the operator's standing complaint ("sessions dying is getting REALLY bad").

## Root cause

The age-limit reaper consults **only** the per-session lifetime cap. It does not
know that the session's TOPIC is mid-autonomous-run, so it (a) recycles at a
point the run considers its midpoint and (b) classifies the recycle as a
`terminal` disappearance rather than a continuation.

## Design forks

**F1 — Does an age-reaped autonomous session auto-respawn, or only on next message?**
Today the respawn is message-triggered (the bridge's routing path detects the
dead session). For an operator away from the keyboard, an autonomous run could
sit stopped until they next message — so *silently* reclassifying the reap as a
bounce would HIDE a real stop. **Lean:** do NOT silence unconditionally. Two
sub-options, pick by F2.

**F2 — Suppress the recycle, or just tell the truth about it?**
- (a) *Respect the run window*: while a topic has an active autonomous run, the
  per-session age cap does not terminally reap — it requests a **kill-to-respawn
  bounce** (disposition `recovery-bounce`) routed through the guaranteed-respawn
  path, so the run continues seamlessly and the notice stays silent (consistent
  with "recovery-bounces stay silent"). Requires a real guaranteed-respawn seam.
- (b) *Honest wording* (lower risk, no behavior change): keep the recycle, but
  when the topic has an active autonomous run, replace the gravestone with an
  honest continuation notice: "🔄 Session recycled at its lifetime cap — your
  autonomous run (Xh left) continues; I'll resume on my own / on your next
  message." Never claims "max runtime reached" while the run clock has hours left.

**Lean:** ship (b) first (truthful, zero behavior change, removes the false
death framing immediately and safely). F2a is tracked, not dropped <!-- tracked: CMT-1520 -->: pursue it only once a guaranteed auto-respawn seam for autonomous runs is verified to exist — because (a)'s correctness *depends* on that guarantee (F1).

## Proposed change (increment 1 = F2b)

1. `SessionManager` age-limit block: detect "topic has an active autonomous run"
   via the existing autonomous-session source (the same state `/autonomous/sessions`
   reads). Thread that fact onto the `sessionReaped` event (new optional field,
   e.g. `autonomousRunActive: true` + `runRemainingSeconds`).
2. `ReapNotifier`: when `reason === 'age-limit'` AND `autonomousRunActive`, emit
   the honest continuation copy instead of the terminal-death template (and do
   NOT contradict the live run clock). All other reaps unchanged.
3. Never silence a reap whose run is NOT active — a genuine terminal stop still
   surfaces loudly.

## Testing (Testing Integrity Standard — all three tiers)

- **Unit:** ReapNotifier emits continuation copy for `age-limit + autonomousRunActive`,
  and the legacy gravestone for `age-limit` without an active run; the copy never
  asserts "maximum runtime" when `runRemainingSeconds > 0`.
- **Integration:** the `sessionReaped` → notify HTTP path carries `autonomousRunActive`
  end-to-end and the rendered notice matches.
- **E2E:** an autonomous-backed session crossing the age cap idle produces a
  continuation notice (not a gravestone) AND the run record stays `active`.

## Migration parity

Notice-copy-only + an additive event field — no agent-installed-file change, so
no `PostUpdateMigrator` entry required. Behavior for non-autonomous reaps is
byte-identical.

## Out of scope (tracked, not dropped)

F2a (suppress-and-bounce respecting the run window) is tracked <!-- tracked: CMT-1520 --> pending verification of a guaranteed autonomous auto-respawn seam (F1). Increment 1 is complete on its own terms — it makes every age-limit recycle of an active run honest; it does not leave a half-fixed surface.
