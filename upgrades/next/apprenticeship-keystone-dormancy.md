## What Changed

The apprenticeship program's `keystoneBalance` health signal gained a **dormancy**
dimension. Previously it only flagged `starved` — oversight cycles piling up
without a mentee drive. A keystone (deepest-layer) that simply went *silent* —
zero cycles of any kind — read "healthy" because `oversightSinceKeystone` stayed
0, even when the last real drive was a day old. This was surfaced by dogfooding
the signal during a live run: the registered `codey-to-gemini` instance reported
healthy while its last mentee drive was ~24h stale.

`keystoneBalance` now also returns `dormant`, `lastKeystoneAgeMs`, and
`dormancyThresholdMs`. `dormant: true` when the keystone fired before but its last
drive is older than a threshold (default 6h, tunable via `?keystoneDormancyMs=N`
on the role-coverage route). `dormant` is orthogonal to `starved` — a layer can be
either, both, or neither. Future-dated timestamps clamp age to 0 (no false
dormancy from clock skew). Observe-only; it never gates.

## What to Tell Your User

Nothing user-facing here — this is an internal refinement to how the apprenticeship
program watches its own health. If you run a mentorship loop, the deepest layer
going quiet for too long is now reported honestly instead of looking fine. No
action needed.

## Summary of New Capabilities

- `GET /apprenticeship/instances/:id/role-coverage` returns `dormant`,
  `lastKeystoneAgeMs`, and `dormancyThresholdMs` in the `keystoneBalance` block.
- New `?keystoneDormancyMs=N` query knob tunes the dormancy threshold (default 6h).
- Existing agents receive the awareness line via an idempotent CLAUDE.md migration.

## Evidence

- Tier-1 unit: dormant/not-dormant, exact threshold boundary, orthogonality with
  `starved`, never-fired, and clock-skew clamp — `tests/unit/apprenticeship-cycle-store.test.ts` (33 passing).
- Tier-2 integration: the route surfaces the new fields and honors
  `?keystoneDormancyMs` both ways — `tests/integration/apprenticeship-routes.test.ts` (23 passing).
- Tier-3 e2e: the dormant path is alive through the real AgentServer —
  `tests/e2e/apprenticeship-lifecycle.test.ts` (8 passing).
- Migration parity: append-text + idempotent in-place shape upgrade, with a test —
  `tests/unit/PostUpdateMigrator-layerBalance.test.ts` (5 passing).
- Full typecheck clean.
