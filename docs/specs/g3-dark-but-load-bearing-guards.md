---
title: "G3 — Dark-but-Load-Bearing Guard Classification (a critical-path dependency on a dark feature is a visible gap, not silence)"
slug: "g3-dark-but-load-bearing-guards"
author: "echo"
status: "draft"
parent-principle: "A Dark Feature Guards Nothing — a load-bearing path depending on a dark/disabled feature must force a decision, not sit quiet"
sibling-principles: "Verify the State, Not Its Symbol; Signal vs. Authority (this classifies + surfaces, it never gates); Bounded Notification Surface; Runtime End-to-End Proof"
parent-spec: "docs/specs/GUARD-POSTURE-ENDPOINT-SPEC.md; docs/STANDARDS-REGISTRY.md (A Dark Feature Guards Nothing — ratified 2026-07-01, PR #1316)"
project: "self-healing-mesh (topic 29836)"
upstream-filings: "fb-dd043916-28f (the dark-but-load-bearing gap named in the S1-S6 postmortem entries)"
---

# G3 — Dark-but-Load-Bearing Guard Classification

## 1. Problem

The guard-posture inventory (`GET /guards`, `guardPostureView.deriveGuardRow`)
already classifies an `off` guard into two `offClass` values:

- `dark-default` — ships-dark, off = NORMAL, quiet (never alarms; correct for a
  genuinely-optional dark feature).
- `diverged-from-default` — default-on but currently off = the load-shed alarm
  (surfaces on `GET /guards`, the heartbeat `offDeviantKeys`, and the
  GuardPostureProbe).

The gap: a feature that ships DARK (`dark-default`, quiet) but that a CRITICAL PATH
DEPENDS ON is indistinguishable, in the inventory, from a genuinely-optional dark
feature. It sits quiet — yet the critical path it should guard is running UNGUARDED.
This is exactly the failure mode the ratified standard **"A Dark Feature Guards
Nothing"** names: *a load-bearing path depending on a dark/disabled feature must force
a decision (graduate it, or record an accepted manual fallback) — never sit silently
dark.* The 2026-07-01 silent-loss postmortem is the case study: several guards that
would have caught the incident shipped dark, and nothing surfaced that a critical path
(operator message delivery) depended on them.

Today the inventory cannot even EXPRESS "this dark feature is load-bearing," so the
standard has no structural arm at the guard layer — it is documented-only. G3 gives it
one.

## 2. Design

**Add a `loadBearing` declaration to the guard manifest, surface it as a distinct
inventory signal, and let the existing GuardPostureProbe raise ONE deduped item when a
load-bearing guard is dark/dry-run — observe-only, never a gate.**

### 2.1 Manifest declaration (`src/monitoring/guardManifest.ts`)

Extend `GuardManifestEntry` with:
```ts
/** A critical path DEPENDS ON this guard. When true, an `off`(dark-default) or
 *  `on-dry-run` posture is a VISIBLE GAP (surfaced + probe-alertable), not the
 *  normal quiet of an optional dark feature. Absent ⇒ false (optional, quiet). */
loadBearing?: boolean;
/** Short human label naming the critical path that depends on it, for the
 *  surfaced signal (e.g. "operator message delivery"). Required when
 *  loadBearing is true. */
criticalPath?: string;
```
Curating WHICH guards are load-bearing is a deliberate, reviewed list (frontloaded
below) — it is NOT inferred. A guard is load-bearing only when a user-visible critical
outcome silently degrades if it is off.

### 2.2 Classifier surface (`guardPostureView.deriveGuardRow`)

The precedence table and the nine `GuardEffectiveState` values are UNCHANGED (G3 does
not add an effective-state — that would ripple through every consumer; it adds an
orthogonal FLAG). `deriveGuardRow` sets, on the row:
```ts
loadBearing?: true;         // mirrored from the manifest
criticalPath?: string;      // the label
loadBearingGap?: true;      // derived: loadBearing AND effective ∈ {off(dark-default), on-dry-run}
```
`loadBearingGap` is the load-bearing analog of `offDeviant`: it is TRUE only when a
load-bearing guard is in a posture that means "the critical path is unguarded" — an
`off` with `offClass:'dark-default'`, or `on-dry-run` (watching but toothless). A
load-bearing guard that is `on-confirmed` sets `loadBearing:true` but NOT the gap flag.
Add `loadBearingGap` + `loadBearingGapKeys` to `GuardsSummary` and the heartbeat
`GuardPostureSummary` (so the pool view surfaces it cross-machine). Extend
`ROW_FIELD_ALLOWLIST` with `loadBearing`, `criticalPath`, `loadBearingGap` (the closed
projection must name them or they never leave the server — the Tier-1 allowlist test).

### 2.3 The surfaced signal (`GuardPostureProbe`)

The existing GuardPostureProbe already raises ONE aggregated Attention item when an
anomaly persists across consecutive probes (for `diverged-from-default` /
`off-runtime-divergent`). G3 adds `loadBearingGap` to the anomaly set: a load-bearing
guard that stays dark/dry-run across consecutive probes raises ONE deduped item —
"N load-bearing guard(s) are dark: <criticalPath list>. Graduate them or record an
accepted manual fallback (A Dark Feature Guards Nothing)." Coalesced per the existing
probe dedup + the Topic-Flood/Bounded-Notification guards — never one-per-guard,
never a new topic. Observe-only: it NEVER gates a session, blocks a message, or
disables anything (Signal vs. Authority — the decision to graduate stays the
operator's / the building agent's).

## 3. Decision points touched

G3 introduces NO new block/allow/route gate. It adds an inventory FLAG + one probe
anomaly class. The only judgment is manifest curation (which guards are load-bearing),
which is frontloaded (§Frontloaded Decisions) and reviewed like any manifest edit.

## 4. Multi-machine posture (mandatory)

Per-machine BY DESIGN with a pool read: each machine classifies its OWN guards
(`loadBearing` is a manifest constant, identical everywhere; the GAP is per-machine —
a guard dark on the Mini but on-confirmed on the Laptop is a per-machine fact). The
heartbeat `GuardPostureSummary` carries `loadBearingGapKeys`, so `GET /guards?scope=pool`
and the Machines dashboard tab surface a load-bearing gap on ANY machine (the same
path `offDeviantKeys` already rides). The probe item is pool-coalesced (both machines
with the same load-bearing gap raise ONE item).

## 5. Tests

- `loadBearing-dark-default-off-sets-loadBearingGap` (the core: a dark load-bearing
  guard is flagged, not quiet).
- `non-loadBearing-dark-default-off-stays-quiet` (no false alarm on optional dark
  features — the whole point of not alarming every dark feature).
- `loadBearing-on-dry-run-sets-loadBearingGap` (toothless-but-watching is still a gap).
- `loadBearing-on-confirmed-sets-flag-but-not-gap`.
- `loadBearingGap-appears-in-summary-and-heartbeat-keys`.
- `allowlist-projection-includes-loadBearing-fields` (Tier-1: the closed field set).
- `probe-raises-one-deduped-item-for-loadBearing-gaps` (+ pool-coalesced across
  machines; never per-guard).
- `criticalPath-required-when-loadBearing-true` (manifest lint / schema test).
- Multi-machine: `dark-on-one-machine-surfaces-in-pool-view`.
- Migration parity: `guardManifest-loadBearing-additions-reach-existing-agents`
  (the manifest ships in code — new entries reach agents on update; a Tier-3
  feature-alive e2e asserts `/guards` returns the new fields, not 503).

## 6. Rollback / rollout

The classification (the flag + summary + allowlist) ships ALWAYS-ON as pure
observability — it adds fields, never removes or gates (byte-identical `/guards`
behavior on every existing consumer that ignores the new fields). The PROBE alert on
`loadBearingGap` ships behind the existing GuardPostureProbe enablement + a
`monitoring.guardPostureProbe.alertLoadBearingGaps` sub-flag (default on once soaked;
off = the flag is still visible on `/guards`, just no proactive item). Rollback = drop
the sub-flag; `/guards` keeps the classification. No new store, no new endpoint, no new
notification surface (rides the probe's existing one).

## Frontloaded Decisions

1. **A FLAG (`loadBearingGap`), not a new `GuardEffectiveState`** — a new effective
   state would ripple through the precedence table + every consumer + the Tier-1
   allowlist; an orthogonal flag is additive and cannot regress the existing nine-state
   contract. (Contested-cheap: N/A — internal inventory shape, observe-only.)
2. **Curated `loadBearing` list, not inferred** — "critical path depends on it" is a
   judgment; the manifest author declares it with a `criticalPath` label, reviewed like
   any manifest edit. Initial load-bearing set (the reviewed frontload): the guards a
   user-visible critical outcome depends on — e.g. the reap-notify / mid-work resume
   queue (interrupted work silently lost), the delivery-failure sentinel (Telegram
   relay recovery), the sentinel trio recovery paths, and the silent-loss
   refusal-conservation guards once landed. The exact list is a reviewed manifest edit,
   expanded conservatively (a false "load-bearing" produces noise; the bar is
   user-visible silent degradation).
3. **Observe-only, rides the existing probe** — Signal vs. Authority; G3 never gates
   or graduates a feature itself. It surfaces the decision; the operator / building
   agent decides. No new notification topic (Bounded Notification Surface).
4. **Always-on classification, opt-in alert** — the flag is pure observability
   (safe always-on); only the proactive item is flag-gated, soaked before default-on.

## Open questions

None.

> The initial load-bearing manifest set (Decision 2) is a reviewed list finalized at
> implementation against the current manifest — a frontloaded curation task, not an
> open question (the CRITERION is fixed: user-visible silent degradation if off).
