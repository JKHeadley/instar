<!-- bump: minor -->

## What Changed

Adds apprenticeship role-coverage visibility on top of `ApprenticeshipCycleStore`.

Cycle rows now use a controlled `kind` vocabulary for the role axis:

- `mentor-mentee-differential`
- `overseer-apprentice-devreview`
- `overseer-mentee-direct`
- `unknown`

Historical `differential-cycle` rows are backfilled/read as `unknown`, so the system never invents
role coverage from pre-vocabulary data. New cycle writes default missing `kind` to
`mentor-mentee-differential`, and invalid labels are rejected.

Adds read-only `GET /apprenticeship/instances/:id/role-coverage`. It returns per-axis
`{ fired, cycleCount, lastAt }`, an `unknown` bucket, `dormantAxes`, and `driftWarning`. The warning
is true when the mentor-mentee differential axis is dormant while the overseer-apprentice dev-review
axis has at least two cycles. This is observability-only; it does not gate transitions or messages.

## What to Tell Your User

- **Apprenticeship role coverage is visible**: "I can now show whether an apprenticeship is actually
  exercising the mentor-to-mentee learning loop, or just accumulating easier review cycles. It is a
  read-only warning surface; it will not block work by itself."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Apprenticeship role coverage | `GET /apprenticeship/instances/:id/role-coverage` shows per-axis coverage and drift warning state. |
| Explicit cycle axis vocabulary | `POST /apprenticeship/cycles` accepts `mentor-mentee-differential`, `overseer-apprentice-devreview`, `overseer-mentee-direct`, or `unknown` as the cycle kind. |

## Evidence

Verification:

- Unit: cycle-kind defaulting, invalid-kind rejection, legacy `differential-cycle` to `unknown`, drift
  true, healthy mix false, and empty instance false.
- Integration: route auth, 503 when cycle store is unavailable, drift true, healthy false, and empty
  false through the real router.
- E2E: production `AgentServer` route is alive and reports drift for the seeded dev-review-only
  pattern.
- Capability discoverability: `CapabilityIndex` advertises the route and
  `tests/unit/capabilities-discoverability.test.ts` was run explicitly.
