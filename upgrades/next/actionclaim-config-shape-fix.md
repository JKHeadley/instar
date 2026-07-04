---
user_announcement:
  - audience: agent-only
    maturity: stable
---

## What Changed

Fixed a config-shape bug that made the **Action-Claim Follow-Through Sentinel** (including the
Slack-followthrough registration lane) impossible to enable on real installs. The sentinel gated on
`messaging.actionClaim.enabled`, but on every real install `messaging` is a JSON **array** of adapter
configs — so the dot-path `messaging.actionClaim.*` was unreachable (an array has no `actionClaim`
property), and the read always returned the `false` default. Because the sentinel defaults OFF, its
master switch could never be turned on. The tests didn't catch it because they all used an
object-shaped `messaging`, which no real install uses. The enable/config now lives at a reachable
**top-level `actionClaim`** block (the legacy object-shaped `messaging.actionClaim` is still honored
for back-compat).

## What to Tell Your User

Nothing proactive — this is an internal enablement fix for a feature that ships off by default. If a
user asks why the promise follow-through tracker (the thing that turns "I'll post that in about five
minutes" into a durable commitment) never activated even after they tried to switch it on, the answer
is that the on-switch was written in a spot the program could never actually read; it now lives in a
reachable place and can genuinely be turned on (tried on a development agent first, before any wider
rollout).

## Summary of New Capabilities

- The Action-Claim / Slack-followthrough sentinel is now **enablable** on real (array-`messaging`)
  installs via top-level `actionClaim.enabled` (plus `actionClaim.slack`, `actionClaim.perTopicCap`,
  `actionClaim.expiresHours`).
- Legacy object-shaped `messaging.actionClaim` config keeps working unchanged.
- No behavior change while the feature stays dark (its default); this only makes the switch reachable.

## Evidence

- `tests/integration/action-claim-config-shape.test.ts` — with array-shaped `messaging` + top-level
  `actionClaim.enabled:true`, a promise like "I'll restart the server now" registers a durable
  commitment (returns `feature-disabled` before the fix); tuning knobs honored; explicit-false
  off-switch works; object-shaped `messaging.actionClaim` back-compat verified.
- `tests/unit/action-claim-hook-slack.test.ts` — the generated Stop hook resolves config array-safely
  (reads top-level `cfg.actionClaim`, `Array.isArray`-guards the legacy fallback).
- Existing route (14) + e2e lifecycle (4) + generated-hooks-parse (25) + migration (5) tests stay
  green; `tsc --noEmit` clean.
- Side-effects review: `upgrades/side-effects/actionclaim-config-shape-fix.md`.
