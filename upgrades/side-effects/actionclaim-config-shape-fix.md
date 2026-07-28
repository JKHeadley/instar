# Side-Effects Review — Action-Claim sentinel enablable on array-shaped `messaging`

**Version / slug:** `actionclaim-config-shape-fix`
**Date:** `2026-07-04`
**Author:** `Echo`
**Second-pass reviewer:** `not required (Tier-1)`

## Summary of the change

The Action-Claim Follow-Through Sentinel (including the Slack-followthrough lane from #1361)
gated on the config path `messaging.actionClaim.enabled`. On every real install `messaging` is a
JSON **array** of adapter configs, so `messaging.actionClaim.*` is unreachable — `LiveConfig`'s
`getNestedValue` walks `messaging`, gets the array, evaluates `array['actionClaim']` → `undefined`,
and returns the `false` default. Because this sentinel defaults OFF, the master gate could never be
set true: the feature was **structurally un-enablable in production**. CI never caught it because
every test wrote an object-shaped `messaging`, which no real install uses. Fix: read the config from
a reachable **top-level `actionClaim`** block (canonical), honoring the legacy object-shaped
`messaging.actionClaim` as a back-compat fallback. Files: `src/server/routes.ts` (the
`/action-claim/observe` reads, via a small `acGet` live-read helper), `src/core/PostUpdateMigrator.ts`
(the generated Stop hook's raw-file resolution + the CLAUDE-template enable-key text),
`src/scaffold/templates.ts` (the scaffold CLAUDE-template enable-key text), plus tests.

## Decision-point inventory

- `POST /action-claim/observe` config reads (`src/server/routes.ts`) — **modify** — master `enabled`,
  `slack.enabled` dev-gate value, `slack.dryRun`, `perTopicCap`, `expiresHours` now resolve
  top-level-first via `acGet`.
- Generated `action-claim-followthrough.js` Stop hook (`PostUpdateMigrator.getActionClaimFollowthroughHook`)
  — **modify** — the raw-file `enabled` resolution reads top-level `cfg.actionClaim` and Array-guards
  the legacy `cfg.messaging.actionClaim` fallback.
- The `messaging.actionClaim.slack.enabled` dev-gate (`resolveDevAgentGate`) — **pass-through** — value
  now sourced via `acGet` but the `undefined → live-on-dev, dark-fleet` semantics are unchanged.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The change only affects whether a
signal-only, never-blocking sentinel can be turned ON. An explicit top-level `actionClaim.enabled:false`
correctly keeps it off (covered by a test).

## 2. Under-block

No block/allow surface — under-block not applicable. The sentinel remains dark by default (absent
config → `false`); the fix does not change detection precision, only config reachability.

## 3. Level-of-abstraction fit

Right layer. This is a config-resolution fix at the exact read sites that were broken; it introduces
no new authority and reuses the existing `LiveConfig` getter and the raw-file read in the generated
hook. It does not re-implement config parsing — it adds a top-level-first fallback around the
existing getters.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface. It changes config reachability for a signal-only
  sentinel (the Stop hook always `exit(0)`; the observe route never blocks a message). No brittle
  logic gains blocking authority.

## 5. Interactions

- **Shadowing:** none. The `acGet` helper reads top-level first, then falls back to the old
  `messaging.actionClaim` path with the same default — a superset of prior behavior. Object-shaped
  configs (existing tests) resolve identically via the fallback.
- **Double-fire:** none. Single read path per field; no new emitter.
- **Races:** none. Reads are per-request via `LiveConfig` (live, no shared mutable state added).
- **Feedback loops:** none.

## 6. External surfaces

- **Other agents / install base:** the generated Stop hook is regenerated on every migration
  (`instar/` hooks are always-overwritten), so existing agents pick up the array-safe resolution on
  their next update — no per-agent config migration required (a fresh top-level `actionClaim` enable
  is purely additive).
- **External systems:** none changed. Slack/Telegram delivery paths untouched.
- **Persistent state:** none. No new ledger/column/file.
- **Operator surface:** no operator-facing action added — enabling is a config edit (dev-first soak),
  same as before, now at a reachable key. "No operator-facing actions" — the CLAUDE-template text was
  corrected so agents point operators at the reachable `actionClaim.enabled` key.

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, approval page, or grant/secret form is
touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** Config (`.instar/config.json`) is per-machine, and the Action-Claim
sentinel already runs per-machine on the machine that owns the responding session (it registers under
that session's own bind token — slack-followthrough-generalization §4.5). This change only alters
*where in the local config file* the enable flag is read; it introduces no cross-machine state, no
user-facing notice, no durable state, and no URLs. Enabling it on one machine does not and should not
implicitly enable it on another — each machine's config is authoritative for its own sessions.

## 8. Rollback cost

Pure code change — revert and ship as a patch. No persistent state, no data migration, no user-visible
regression during the rollback window. The generated hook is regenerated on the next migration in
either direction. A deployed agent that had set top-level `actionClaim.enabled:true` would, on
rollback, simply return to un-enablable (the pre-fix state) — no cleanup needed.

## Conclusion

The review confirms a low-risk, additive config-resolution fix that makes a previously un-enablable
default-off sentinel actually turnable-on on real (array-`messaging`) installs, with the legacy
object-shape fully back-compatible. It adds the missing test coverage (array-shaped `messaging`) that
would have caught the original bug. Clear to ship. Follow-up worth tracking: the sibling default-ON
`messaging.*` sentinels (`toneGate`, `outboundAdvisory`) share the same latent unreachability but are
masked by their on-by-default posture — noted here, not fixed in this change (out of scope).

---

## Second-pass review (if required)

**Reviewer:** not required (Tier-1)
**Independent read of the artifact: n/a**

---

## Evidence pointers

- `tests/integration/action-claim-config-shape.test.ts` — array-shaped `messaging` + top-level
  `actionClaim`: enablement, tuning-knob read, explicit-false off-switch, object-shape back-compat.
- `tests/unit/action-claim-hook-slack.test.ts` — hook-body array-safe resolution assertion.
- Existing `tests/integration/action-claim-route.test.ts` (14) + `tests/e2e/action-claim-lifecycle.test.ts`
  (4) + `tests/unit/generated-hooks-parse.test.ts` (25) + `tests/unit/migrate-actionclaim-slack-devgate.test.ts`
  (5) all stay green; `tsc --noEmit` clean.
- `docs/investigations/s7-slack-delivery-repro-2026-07-04.md` — the S7 keystone investigation that
  surfaced this bug (the merged #1361 fix could not be turned on).

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `config-unreachable-on-shape` (`novel`; nearestExistingClass:
  `feature-un-enablable`; includes: a config gate whose dot-path is unreachable given the container's
  real runtime shape, e.g. a key nested under an array-valued parent; excludes: a feature disabled by a
  correctly-read explicit flag). Enters `status: "unconfirmed"` pending operator confirmation, so this
  fix carries `closure: gap` (below), not `closure: guard`.
- **`closure`** — `gap` — the class-level guard (a lint that flags a `messaging.<x>` dot-path read when
  `messaging` is array-shaped in the shipped config, or a shape-fuzzing test harness for config gates)
  is out of scope for this fix.
- **`guardEvidence`** — n/a for `closure: gap`.
- **`gap`** — tracked as a standards-gap follow-up: "config-gate shape-reachability lint/fuzz — a
  default-off feature gated on an unreachable dot-path is un-enablable; add a guard that fails when a
  gate reads `messaging.<child>.*` given `messaging` ships as an array." (This change ships the direct
  regression test for THIS feature; the class-level guard is the tracked gap.)
