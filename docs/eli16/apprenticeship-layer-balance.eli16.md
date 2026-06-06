# Apprenticeship layer-balance signal - ELI16

> The one-line version: the apprenticeship program can now SEE when its deepest layer (the real mentor→mentee drive) is starving while it keeps busy reviewing and overseeing — so the "mentor-heavy / mentee-light" drift can't silently happen for days again.

## The problem (a real one, found 2026-06-06)

A holistic check of the program showed it was lopsided: the mentor layer (Echo→Codey) had run 13 cycles while the mentee layer (Codey→Gemini) had run only 3. The recursion was real on paper but barely exercising its deepest layer. Nothing in the system surfaced that — it took a human noticing to catch it. By our own constitution ("Observation Needs Structure"), a duty to notice something is a wish unless the structure makes it visible.

## What already existed

The program already records every cycle and already knows which axis each cycle belongs to: the keystone `mentor-mentee-differential` (the mentor actually drove the mentee) vs oversight (`overseer-apprentice-devreview`, `overseer-mentee-direct`). It even had a narrow `driftWarning` — but that only fired in one special case (keystone NEVER ran AND ≥2 reviews). It said nothing about the common case: the keystone fired once long ago and the program then drifted into pure review.

## What this adds

A `keystoneBalance` block on the existing role-coverage answer (`GET /apprenticeship/instances/:id/role-coverage`). For any instance it reports, in plain terms:
- how many real keystone drives have happened and when the last one was,
- how much oversight has piled up SINCE that last drive,
- `starved: true/false` — is the deepest layer under-firing relative to ongoing activity,
- a plain-English `reason`.

`starved` is true when either the keystone never ran while oversight did, OR enough oversight has accrued since the last drive (default 3, tunable per call). It generalizes the old narrow drift-warning to catch the "fired-but-now-stale" case the assessment actually hit.

## What it deliberately does NOT do

It is **observe-only**. It never blocks a cycle, never gates anything, never changes the loop's behavior. It only makes the imbalance a queryable fact. That's the honest order we follow: ship the observation structure first, prove it, and only then consider an enforcement/cadence rule (a natural phase-2) that would auto-rebalance.

## A nice immediate proof

A `direct-shortcut` mentor-mentee-differential (a drive that bypassed the dogfooded channel) does NOT count toward the keystone — so even a drive that "ran" but skipped the real UX still reads the layer as un-driven. The signal catches the near-miss, not just the obvious gap.

## Evidence

Computed purely from existing cycle rows (no new storage, no migration). All three test tiers green, both sides of every boundary (never-fired starves; before-keystone oversight doesn't; exactly-at-threshold starves, one-below doesn't; shortcut still reads un-driven; empty instance is calm).
