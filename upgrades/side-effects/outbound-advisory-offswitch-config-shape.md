# Side-Effects Review — outbound-advisory off-switch reachable on array-shaped messaging

**Version / slug:** `outbound-advisory-offswitch-config-shape`
**Date:** `2026-07-04`
**Author:** `Echo`
**Second-pass reviewer:** `not required (Tier-1)`

## Summary of the change

The outbound-advisory preflight route read its off-switch (and tuning knobs) at
`messaging.outboundAdvisory.*`. On a real install `messaging` is a JSON **array** of adapter configs,
so that dot-path resolves `undefined` → the read's default. For the `enabled` read (default `true`)
that meant the **documented off-switch (`messaging.outboundAdvisory.enabled: false`) had no effect —
an operator could not disable the advisory** (the un-DISABLABLE sub-class of the PR #1379 bug). Fix:
read from the reachable **top-level `outboundAdvisory`** block (canonical), honoring the legacy
`messaging.outboundAdvisory` as a back-compat fallback. Applied to all four reads
(`enabled`, `ignoreEscalationThreshold`, `ignoreEscalationSlugThreshold`, `timeClaim.enabled` dev-gate),
the documented off-switch key in both templates, and an existing-agent CLAUDE.md doc migration.
Files: `src/server/routes.ts`, `src/core/PostUpdateMigrator.ts`, `src/scaffold/templates.ts`, + test.

## Decision-point inventory

- `POST /messaging/preflight` `enabled` gate (`routes.ts`) — **modify** — top-level-first resolution.
- `OutboundAdvisoryAudit` threshold reads (`routes.ts`) — **modify** — top-level-first.
- `timeClaim.enabled` dev-gate value (`routes.ts`) — **pass-through** — sourced top-level-first;
  `undefined → live-on-dev` semantics unchanged.
- CLAUDE template off-switch text (both `PostUpdateMigrator` content + `scaffold/templates`) —
  **modify** — documents the reachable top-level key.
- `PostUpdateMigrator` TIME_CLAIM anchor marker — **modify** — matched on the stable `- Off-switch: \``
  prefix so it still anchors regardless of which key the line carries.
- New `migrateClaudeMd` swap — **add** — updates an existing agent's stale nested-key off-switch line.

## 1. Over-block / 2. Under-block

No block/allow surface change of consequence: the advisory is inform-only and never blocks a message.
The only behavior change is that the **off-switch now actually works** — an operator who sets
`outboundAdvisory.enabled: false` disables the advisory (previously impossible). Over-block N/A;
under-block N/A.

## 3. Level-of-abstraction fit

Right layer — same top-level-first config-read pattern as PR #1379, applied at the read sites. No new
authority, no new machinery.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — no runtime block/allow surface changes; the advisory remains inform-only. This restores a
  broken operator control (an off-switch), it does not add gating authority.

## 5. Interactions

- **Shadowing:** none — top-level-first read is a superset of prior behavior; on object-messaging the
  legacy fallback resolves identically.
- **Double-fire / races / feedback loops:** none.
- **Migration marker:** the TIME_CLAIM anchor now matches the stable `- Off-switch: \`` prefix, so it
  still finds the off-switch line whether CLAUDE.md carries the old nested or the new top-level key —
  verified the substring is present in both.

## 6. External surfaces

- **Install base / agents:** existing agents get the corrected off-switch DOC via the new
  `migrateClaudeMd` swap (content-sniff, idempotent) on their next update; new agents via the
  templates. The CODE fix ships with the server. No config migration needed to keep working (top-level
  is additive; legacy still honored).
- **Operator surface:** restores a documented operator control (the off-switch). No new UI/route.
- **Persistent state / external systems:** none.

## 6b. Operator-surface quality

No dashboard/approval/form surface — not applicable (the off-switch is a config edit, now at a
reachable key, documented for the operator).

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** — config (`.instar/config.json`) is per-machine; the advisory runs
per-machine on the sending machine. This change only alters where in the local config the flag is
read. No cross-machine state, notice, durable state, or URL.

## 8. Rollback cost

Pure code + doc change — revert the reads + template text + the one migration block. No persistent
state; the top-level key is additive and the legacy fallback preserves prior behavior. Zero-cost
back-out.

## Conclusion

Restores the outbound-advisory off-switch that was silently broken on every real (array-`messaging`)
install — the un-DISABLABLE sibling of the PR #1379 un-ENABLABLE bug, found by the sibling audit
(`docs/investigations/messaging-config-unreachable-audit-2026-07-04.md`). Code + docs + existing-agent
migration + a real-LiveConfig array-shape test. Clear to ship.

## Second-pass review (if required)

**Reviewer:** not required (Tier-1)

## Evidence pointers

- `tests/unit/outbound-advisory-config-shape.test.ts` — real LiveConfig + real array-shaped config:
  top-level off-switch disables (was impossible before the fix), default-on when unset, object-shape
  back-compat.
- Existing `outbound-advisory-routes` / `outbound-advisory` / `telegram-reply-advisory-script` tests
  (58) stay green; `tsc` clean; `lint-no-unreachable-messaging-gate` clean.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `config-unreachable-on-shape` (the PR #1379 class; this is its un-DISABLABLE
  default-ON sub-class).
- **`closure`** — `gap` — the #1381 lint catches the default-OFF (un-enablable) sub-class; the
  default-ON un-disablable sub-class (`.get('messaging.*.enabled', true)` with a documented off-switch)
  is not reliably lint-detectable without false positives (documented in the #1381 side-effects
  follow-ups). This fix ships the direct regression test + moves the config to the reachable
  convention; the class-level guard for the un-disablable sub-class remains a tracked gap.
- **`guardEvidence`** — n/a for `closure: gap`.
- **`gap`** — tracked in `docs/investigations/messaging-config-unreachable-audit-2026-07-04.md`
  (follow-up 2) + the #1381 side-effects artifact.
