<!-- bump: patch -->

## What Changed

Slice 2 of the Skill Learning Sentinel (spec `docs/specs/skill-learning-sentinel.md`): the write path, still
**dark** (`monitoring.skillLearning.enabled: false`) and only active in `mode: live`, which no agent sets until
the feature's dev-agent rung has run.

- A lease-fenced, journaled commit protocol writes a learned skill's master copy and renders it through the
  existing reconciler; an interrupted write is finished, voided, or locked for the operator at the next boot —
  never half-applied. Writes happen only on the lease holder after a successful pull; a failed pull aborts.
- New skills land as **pending** (invisible to every coding tool) until the operator confirms them on the console
  with the PIN, or until the feature's second rung is proven. Confirm/reject taps forward to the lease holder.
- Versions are recorded per machine; after a sync the higher lease epoch wins, and an undecidable merge renders
  nothing and surfaces both bodies as proposals.
- The index cost of rendered skills is measured each tick and shown to the drafter and reviewer.
- Skill-use telemetry is joined to versions; renderings edited by hand are scored separately.

## What to Tell Your User

Still nothing to do. When the trial reaches its second stage, a skill I have learned will appear on the console
as "pending" with a Confirm button; until you confirm, no coding tool sees it.

## Summary of New Capabilities

- Journaled, lease-fenced writes of learned skills (live mode only).
- Pending/confirm flow on the console and the API.
- Version shards with epoch reconciliation; index-cost measurement.

## Evidence

Unit, integration and e2e tests at all three tiers (see the PR); side-effects review with second pass in
`upgrades/side-effects/skill-learning-sentinel-slice2.md`.
