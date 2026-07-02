---
title: "G3 — Dark-but-Load-Bearing Guard Classification (a critical-path dependency on a dark feature is a visible gap, not silence)"
slug: "g3-dark-but-load-bearing-guards"
author: "echo"
status: "draft"
parent-principle: "A Dark Feature Guards Nothing — a load-bearing path depending on a dark/disabled feature must force a decision (graduate it, OR record an owned accepted-fallback), not sit quiet"
sibling-principles: "Verify the State, Not Its Symbol; Signal vs. Authority (this classifies + surfaces, it never gates); Bounded Notification Surface; Runtime End-to-End Proof; Agent Awareness Standard"
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
a decision — graduate it, OR record an owned acceptance of the manual fallback (a
recorded decision with an owner, not a shrug) — never sit silently dark.* The
2026-07-01 silent-loss postmortem is the case study: several guards that would have
caught the incident shipped dark, and nothing surfaced that a critical path (operator
message delivery) depended on them.

Today the inventory cannot even EXPRESS "this dark feature is load-bearing," so the
standard has no structural arm at the guard layer — it is documented-only. G3 gives it
one — including BOTH resolution arms the standard mandates (graduate / accept), because
a feature that can only surface the gap but never let the operator close it trains the
operator to ignore it and then disable the whole class (the Bounded-Notification /
one-hub-topic failure mode).

## 2. Design

**Add a `loadBearing` declaration to the guard manifest; surface a `loadBearingGap`
signal for a load-bearing guard that is SILENTLY unguarded; let the operator CLOSE a
gap either by graduating the guard OR by recording an owned accepted-fallback; and make
the `criticalPath` label travel on EVERY anomaly of a load-bearing guard (not just the
silent ones). Observe-only, never a gate.**

### 2.1 Manifest declaration (`src/monitoring/guardManifest.ts`)

Extend `GuardManifestEntry` with:
```ts
/** A critical path DEPENDS ON this guard. When true, a SILENTLY-unguarded posture
 *  (off:dark-default, or on-dry-run past its soak) is a VISIBLE GAP (surfaced +
 *  probe-alertable) unless an owned accepted-fallback is recorded; and the
 *  criticalPath label travels on ANY anomaly for this guard. Absent ⇒ false. */
loadBearing?: boolean;
/** Short human label naming the critical path that depends on it, for the surfaced
 *  signal (e.g. "operator message delivery"). REQUIRED when loadBearing is true. */
criticalPath?: string;
```
Curating WHICH guards are load-bearing is a deliberate, reviewed list (frontloaded
below) — it is NOT inferred. A guard is load-bearing only when a user-visible critical
outcome silently degrades if it is off.

### 2.2 Classifier surface (`guardPostureView.deriveGuardRow`)

The precedence table and the nine `GuardEffectiveState` values are UNCHANGED (G3 does
not add an effective-state — that would ripple through every consumer; it adds
orthogonal FLAGS). `deriveGuardRow` sets, on the row:
```ts
loadBearing?: true;             // mirrored from the manifest
criticalPath?: string;         // the label — present on the row for ANY posture
loadBearingGap?: true;         // derived (see below): SILENTLY unguarded, unaccepted
loadBearingAccepted?: true;    // an owned accepted-fallback is recorded for this gap
acceptedFallbackReason?: string; // the recorded reason (for the visible accepted-risk row)
```
`loadBearingGap` is TRUE iff ALL of: (a) `loadBearing`; (b) effective posture is a
SILENT-unguarded state — `off` with `offClass:'dark-default'`, OR `on-dry-run` that has
been dry-run past its soak window (§2.4); and (c) NO accepted-fallback is recorded for
this guard on this machine. A load-bearing guard that is `on-confirmed`, still within
its soak window, or has a recorded accepted-fallback sets `loadBearing:true` but NOT the
gap flag. **The accepted-fallback term is what lets the anomaly CLEAR** (§2.4) — without
it a permanent-dark-but-accepted guard would hold the probe episode open forever (§2.5).

Add `loadBearingGap` + `loadBearingGapKeys` (and `loadBearingAcceptedKeys`) to
`GuardsSummary` and the heartbeat `GuardPostureSummary` (so the pool view surfaces them
cross-machine). Extend `ROW_FIELD_ALLOWLIST` with `loadBearing`, `criticalPath`,
`loadBearingGap`, `loadBearingAccepted`, `acceptedFallbackReason` (the closed projection
must name them or they never leave the server — the Tier-1 allowlist test).

**`loadBearingGapKeys` is NOT "all unguarded critical paths."** It is the SILENT subset.
A load-bearing guard that is loudly unguarded (`off-runtime-divergent` — the literal
load-shed class — `diverged-from-default`, `missing`, `errored`, `on-stale`) is ALREADY
alarming under its own class; G3 does NOT set `loadBearingGap` there (that would
double-alarm), but it DOES attach the `criticalPath` label to that emission (§2.3) so
the loudest unguarded case — the 2026-06-05 runtime-disable incident that motivates the
standard — carries "a LOAD-BEARING critical path (X) is down," not a bare generic row.

### 2.3 The surfaced signal (`GuardPostureProbe`) — both eval paths, named class

Introduce ONE new `GuardAnomalyClass: 'load-bearing-gap'`. The probe pushes it in BOTH
evaluation paths (today the two are asymmetric — this must be explicit or the local or
peer path silently emits nothing):

- **`evaluateInventory`** (local): after the existing effective-state switch, an
  explicit `if (row.loadBearingGap) push({ class: 'load-bearing-gap', key, criticalPath })`.
  (A load-bearing `off:dark-default` hits `case 'off'` which only pushes on
  `diverged-from-default`; `on-dry-run` hits `default: break` — so without this explicit
  check the local path emits nothing.)
- **`evaluateHeartbeat`** (peer): read `loadBearingGapKeys` from the compact heartbeat
  block, `Array.isArray`-guarded (an un-upgraded peer omits it → treated as empty, never
  a throw), and push the same class for peer gaps.
- **criticalPath annotation (both paths):** for ANY anomaly whose guard is
  `loadBearing`, annotate the emission with `criticalPath` — so the label travels on the
  loud classes too (§2.2), not only `load-bearing-gap`.

The probe raises ONE aggregated Attention item when the anomaly persists across
consecutive probes — "N load-bearing guard(s) are dark: <criticalPath list>. Graduate
them or record an owned accepted-fallback (A Dark Feature Guards Nothing)." Coalesced
per the existing per-episode P17 dedup + the Topic-Flood / Bounded-Notification guards —
never one-per-guard, never a new topic (honors the operator one-hub-topic rule).
Observe-only: it NEVER gates a session, blocks a message, or disables anything (Signal
vs. Authority — the decision to graduate or accept stays the operator's).

### 2.4 Closing a gap — graduate OR record an owned accepted-fallback

The standard mandates two exits; G3 implements both.

- **Graduate** — flip the guard on (`on-confirmed`): the gap posture no longer holds,
  `loadBearingGap` clears naturally. No new mechanism.
- **Accept the fallback** — a durable, per-machine operator record:
  `state/guard-accepted-fallbacks.json`, keyed `<machineId>:<guardKey>` →
  `{ reason, owner, acceptedAt }`. `deriveGuardRow` reads it: a guard that would be
  `loadBearingGap` instead gets `loadBearingAccepted:true` + `acceptedFallbackReason`
  and does NOT set `loadBearingGap`. The risk is **acknowledged, not erased** — it
  surfaces as a distinct VISIBLE accepted-risk row on `/guards` (and a
  `loadBearingAcceptedKeys` summary count), so an accepted fallback is auditable, owned,
  and never silent.
- **Operator route (operator-authenticated, not bare Bearer):** `POST /guards/:key/accept-fallback`
  `{ reason }` records it; `DELETE /guards/:key/accept-fallback` revokes (re-opening the
  gap). It suppresses a SAFETY signal, so it requires the **dashboard PIN** (reuse
  `checkMandatePin`) — my Bearer token is structurally insufficient to accept a risk on
  the operator's behalf (Know Your Principal). Per-machine, because a gap is per-machine.
- **Soak is just an accepted-fallback.** instar ships load-bearing safety automation
  dry-run-FIRST by design (a deliberate, often long soak — e.g. `ResumeQueue` ships
  `dryRun:true` fleet-wide). That legitimate soak is expressed as a SEEDED
  accepted-fallback (`reason: "graduated-rollout soak"`, `owner: <the rollout>`) shipped
  WITH the manifest entry, so a correctly-soaking guard does NOT nag from day one — and
  an `on-dry-run` guard only becomes a `loadBearingGap` once it is dry-run WITHOUT such a
  record (the "abandoned in dry-run," not "legitimately soaking," case). This unifies the
  soak-collision and the accepted-fallback findings: soaking-by-design is one owned,
  visible kind of accepted fallback, distinguishable from abandonment by whether a record
  exists.

### 2.5 Why the accepted-fallback term is load-bearing to the PROBE itself

`GuardPostureProbe` ends an episode ONLY when the anomaly set is empty, and while an
episode is open+emitted it does not re-emit for NEW anomalies. If `loadBearingGap` could
never clear for a deliberately-dark-but-accepted guard, that guard would hold the episode
OPEN FOREVER — silently suppressing every future guard-posture alert, including a real
load-shed on another guard. The accepted-fallback term (§2.4) is precisely what lets the
anomaly clear so the episode can close. This is why accept-recording is not optional
polish — without it G3 breaks the very probe it rides.

## 3. Decision points touched

G3 introduces NO new block/allow/route gate. It adds inventory FLAGS, one probe anomaly
class, and one operator-authenticated ack route (which only SUPPRESSES a signal — never
grants authority). The only judgment is manifest curation (which guards are
load-bearing) + which soaking guards ship a seeded accepted-fallback — both frontloaded
(§Frontloaded Decisions) and reviewed like any manifest edit.

## 4. Multi-machine posture (mandatory)

Per-machine BY DESIGN with a pool read: `loadBearing`/`criticalPath` are manifest
constants (identical everywhere); the GAP and the accepted-fallback are per-machine
facts (a guard dark-and-unaccepted on the Mini but on-confirmed on the Laptop is a
per-machine truth; an accepted-fallback recorded on one machine does not silence the
gap on another — each operator decision is local). The heartbeat `GuardPostureSummary`
carries `loadBearingGapKeys` (+ `loadBearingAcceptedKeys`), so `GET /guards?scope=pool`
and the Machines dashboard tab surface a load-bearing gap on ANY machine (the same path
`offDeviantKeys` already rides; peer path Array.isArray-guarded for un-upgraded peers).
The probe item is pool-coalesced (both machines with the same gap raise ONE item).
Single-machine install = the accept route + per-machine keying degrade to the lone
machine; no behavior change.

## 5. Tests

- `loadBearing-dark-default-off-unaccepted-sets-loadBearingGap` (the core).
- `non-loadBearing-dark-default-off-stays-quiet` (no false alarm on optional dark).
- `loadBearing-on-dry-run-without-soak-record-sets-loadBearingGap`.
- `loadBearing-on-dry-run-with-seeded-soak-fallback-does-NOT-gap` (the soak case).
- `loadBearing-on-confirmed-sets-flag-but-not-gap`.
- `accepted-fallback-clears-loadBearingGap-and-sets-loadBearingAccepted` (+ surfaces the
  visible accepted-risk row).
- `probe-episode-closes-once-gap-accepted` (the §2.5 wedge regression: an accepted gap
  must let the episode end, NOT hold it open).
- `criticalPath-label-travels-on-off-runtime-divergent` (+ missing/errored/on-stale —
  the loud-unguarded case carries the label; loadBearingGap is NOT set there).
- `loadBearingGapKeys-is-silent-subset-not-all-unguarded` (documents the scope).
- `evaluateInventory-pushes-load-bearing-gap-class` AND
  `evaluateHeartbeat-reads-loadBearingGapKeys-arrayguarded` (both paths).
- `accept-fallback-route-requires-dashboard-pin` (Bearer-only is rejected).
- `allowlist-projection-includes-all-five-loadBearing-fields` (Tier-1 closed set).
- `criticalPath-required-when-loadBearing-true` (manifest lint / schema test).
- Multi-machine: `dark-unaccepted-on-one-machine-surfaces-in-pool-view`;
  `accepted-on-one-machine-does-not-silence-peer-gap`.
- Migration parity: `guardManifest-loadBearing-additions-reach-existing-agents`;
  Tier-3 feature-alive e2e asserts `/guards` returns the new fields (not 503) and the
  accept route is mounted.

## 6. Rollback / rollout

The classification (the flags + summary + allowlist + criticalPath annotation) ships
ALWAYS-ON as pure observability — it adds fields, never removes or gates (byte-identical
`/guards` for any consumer that ignores the new fields). The accept-fallback route ships
with the classification (it is half the standard; without it the probe wedges, §2.5).
The PROBE alert on `load-bearing-gap` ships behind the existing GuardPostureProbe
enablement + a `monitoring.guardPostureProbe.alertLoadBearingGaps` sub-flag. **The alert
defaults ON only after the initial load-bearing set's soak/accepted-fallbacks are seeded
(or the guards graduated)** — so shipping never creates an instant fleet-wide nag on
correctly-soaking guards. Rollback = drop the sub-flag; `/guards` keeps the
classification. No new notification surface (rides the probe's existing one).

**Agent Awareness (mandatory).** Extend `src/scaffold/templates.ts` → `generateClaudeMd()`,
the existing "Guard Posture — which safety systems are genuinely on (`GET /guards`)"
section, with the `loadBearingGap` / `criticalPath` / accepted-fallback vocabulary and
the "graduate it OR record an owned accepted-fallback" resolution — so a deployed agent
can explain a "load-bearing guard is dark" attention item and drive its resolution.
Migration parity: the template change reaches existing agents via `migrateClaudeMd()`
(content-sniffed guard), and the manifest additions reach them because the manifest
ships as code.

## Frontloaded Decisions

1. **A FLAG (`loadBearingGap`), not a new `GuardEffectiveState`** — a new effective
   state would ripple through the precedence table + every consumer + the Tier-1
   allowlist; orthogonal flags are additive and cannot regress the nine-state contract.
2. **Curated `loadBearing` list, not inferred** — the CRITERION ("user-visible silent
   degradation if off") is fixed; the manifest author declares each entry with a
   `criticalPath` label, reviewed like any manifest edit. A wrong entry is observe-only,
   reversible by a manifest edit, soak-gated on the alert — so the LIST is cheap. Initial
   set finalized at implementation against the current manifest, choosing guards whose
   posture can actually reach a silent-unguarded state (per the reviewer note that some
   candidates are `defaultEnabled:true` with no dark-default path — those only gap via
   dry-run) and seeding a soak accepted-fallback for the dry-run-by-design ones.
3. **BOTH standard arms implemented (graduate + accept)** — surfacing without a close
   path trains the operator to ignore then disable the class (Bounded-Notification /
   one-hub-topic lesson). Accept is a durable, owned, VISIBLE, per-machine record — never
   a silent suppression. (Contested-cheap: N/A — it is the operator-facing resolution
   contract of a persistent safety signal; built, not deferred.)
4. **Accept route is dashboard-PIN-gated** — it suppresses a safety signal, so it is an
   operator decision; a Bearer token cannot accept a risk on the operator's behalf (Know
   Your Principal). Reuses `checkMandatePin`.
5. **`criticalPath` travels on ALL anomalies of a load-bearing guard; `loadBearingGap`
   is the SILENT subset** — the loud-unguarded states (off-runtime-divergent, missing,
   errored, on-stale, diverged) already alarm; G3 annotates them rather than
   double-alarming, and never lets `loadBearingGapKeys` be misread as "all unguarded."
6. **Soak = a seeded accepted-fallback** — a legitimately dry-run-first guard ships with
   an owned `graduated-rollout soak` acceptance, so it does not nag; an `on-dry-run`
   guard gaps only WITHOUT such a record (abandoned-in-dry-run, distinguishable from
   soaking by whether the owned record exists).
7. **Observe-only, rides the existing probe + surfaces** — Signal vs. Authority; G3
   never gates or graduates a feature itself. No new notification topic.
8. **Always-on classification + accept route; opt-in alert (soak-gated default-on)** —
   the flags are pure observability; only the proactive item is flag-gated and defaults
   on only after the initial set is seeded (no instant fleet nag).

## Open questions

None.

> Both live design points the round-1 reviewers surfaced — the accepted-fallback
> mechanism (Decisions 3-4, 6) and the on-dry-run/soak trigger semantics (Decision 6) —
> are resolved into Frontloaded Decisions above. The initial load-bearing manifest set
> (Decision 2) is a reviewed curation task finalized at implementation against the
> current manifest — a frontloaded task with a fixed criterion, not an open question.
