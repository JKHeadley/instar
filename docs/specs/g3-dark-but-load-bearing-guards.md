---
title: "G3 — Dark-but-Load-Bearing Guard Classification (a critical-path dependency on a dark feature is a visible gap, not silence)"
slug: "g3-dark-but-load-bearing-guards"
author: "echo"
status: "draft"
parent-principle: "A Dark Feature Guards Nothing — a load-bearing path depending on a dark/disabled feature must force a decision (graduate it, OR record an owned operator acceptance), not sit quiet"
sibling-principles: "Verify the State, Not Its Symbol; Signal vs. Authority (this classifies + surfaces, it never gates); Bounded Notification Surface; Runtime End-to-End Proof; Agent Awareness Standard; Maturation Path; Close the Loop"
parent-spec: "docs/specs/GUARD-POSTURE-ENDPOINT-SPEC.md; docs/STANDARDS-REGISTRY.md (A Dark Feature Guards Nothing — ratified 2026-07-01, PR #1316)"
project: "self-healing-mesh (topic 29836)"
upstream-filings: "fb-dd043916-28f (the dark-but-load-bearing gap named in the S1-S6 postmortem entries)"
---

# G3 — Dark-but-Load-Bearing Guard Classification

## 1. Problem

The guard-posture inventory (`GET /guards`, `guardPostureView.deriveGuardRow`)
classifies an `off` guard into two `offClass` values: `dark-default` (ships-dark, off =
NORMAL, quiet) and `diverged-from-default` (default-on but off = the load-shed alarm).

The gap: a feature that ships DARK (`dark-default`, quiet) but that a CRITICAL PATH
DEPENDS ON is indistinguishable, in the inventory, from a genuinely-optional dark
feature. It sits quiet — yet the critical path it should guard is running UNGUARDED.
This is the failure the ratified standard **"A Dark Feature Guards Nothing"** names: *a
load-bearing path depending on a dark/disabled feature must force a decision — graduate
it, OR record an owned operator acceptance (a recorded decision with an owner, not a
shrug) — never sit silently dark.* The 2026-07-01 silent-loss postmortem is the case
study: guards that would have caught the incident shipped dark, and nothing surfaced
that a critical path (operator message delivery) depended on them.

Today the inventory cannot even EXPRESS "this dark feature is load-bearing," so the
standard has no structural arm at the guard layer. G3 gives it one — implementing BOTH
standard arms (graduate / accept) so a surfaced gap can actually be CLOSED, and being
careful (per round-2 review) that a legitimately-soaking guard rides the GRADUATE arm
with re-surfacing pressure rather than being silently suppressed.

## 2. Design

**Add a `loadBearing` declaration + a bounded `soakWindowDays` to the guard manifest.
Classify a load-bearing guard in a silent-unguarded posture into ONE of three states —
`loadBearingGap` (loud: force a decision), `loadBearingSoaking` (softer: in its
graduated-rollout window, re-surfaced on cadence, lapses to Gap at window end), or
`loadBearingAccepted` (owned operator acceptance, full suppression + visible
accepted-risk row). Make `criticalPath` travel on EVERY anomaly of a load-bearing
guard. Observe-only, never a gate.**

### 2.1 Manifest declaration (`src/monitoring/guardManifest.ts`)

```ts
/** A critical path DEPENDS ON this guard (surfaced + probe-alertable when silently
 *  unguarded; criticalPath travels on ANY anomaly). Absent ⇒ false. */
loadBearing?: boolean;
/** REQUIRED when loadBearing: the critical path that depends on it (e.g. "operator
 *  message delivery"). */
criticalPath?: string;
/** Graduated-rollout soak budget, in days from when this guard was DECLARED
 *  load-bearing (a manifest constant — identical fleet-wide, computed against the
 *  guard's declaredLoadBearingAt manifest date). While within the window an on-dry-run
 *  load-bearing guard is `loadBearingSoaking` (softer signal); PAST it, it lapses to
 *  the loud `loadBearingGap`. 0/absent ⇒ no soak grace (dry-run is immediately a Gap).
 *  This is the GRADUATE arm's forcing function — soak is time-bounded, never forever. */
soakWindowDays?: number;
declaredLoadBearingAt?: string; // ISO date the load-bearing flag was added (manifest constant)
```
Curating WHICH guards are load-bearing (and each soak window) is a deliberate, reviewed
manifest edit — NOT inferred. A guard is load-bearing only when a user-visible critical
outcome silently degrades if it is off.

### 2.2 Classifier surface (`guardPostureView.deriveGuardRow`) — PURE, three states

`deriveGuardRow` is a PURE, no-I/O function (its module contract: callers hand in the
snapshot / boot snapshot / registry; it does zero disk access, and its unit tests call
it with synthetic inputs). G3 preserves that: the per-machine operator-accept map is
read ONCE at the orchestration layer (§2.6) and threaded in via a new `DeriveInput`
field (mirroring `bootValue`/`bootSnapshotAvailable`); the soak window +
`declaredLoadBearingAt` are manifest constants already reachable via the registry. The
precedence table and the nine `GuardEffectiveState` values are UNCHANGED — G3 adds
orthogonal FLAGS, not an effective-state.

`deriveGuardRow` sets on the row:
```ts
loadBearing?: true;               // mirrored from the manifest
criticalPath?: string;           // present on the row for ANY posture
loadBearingGap?: true;           // LOUD: silently unguarded, past soak, not accepted
loadBearingSoaking?: true;       // SOFTER: on-dry-run within the manifest soak window
loadBearingAccepted?: true;      // owned operator acceptance recorded (this machine)
acceptedFallbackReason?: string; // the operator's recorded reason (visible accepted-risk row)
```
For a load-bearing guard in a SILENT-unguarded posture (`off:dark-default`, or
`on-dry-run`), exactly one of the three flags is set, by this precedence:
1. **operator-accept recorded** (from the threaded map) → `loadBearingAccepted` (+reason).
   Full suppression of the Gap; surfaces as a VISIBLE accepted-risk row. Reserved for a
   genuine, owned, PIN-recorded operator decision (§2.4).
2. **else on-dry-run AND within `soakWindowDays` of `declaredLoadBearingAt`** →
   `loadBearingSoaking`. A SOFTER signal (graduate arm) — surfaced on `/guards`,
   re-surfaced on the probe's cadence as an informational "soaking" line (NOT the loud
   Gap, NOT full suppression). Lapses to `loadBearingGap` when the window expires.
3. **else** (off:dark-default; OR on-dry-run past the soak window; and no accept) →
   `loadBearingGap`. The LOUD "force a decision" alert.
A load-bearing guard that is `on-confirmed` sets `loadBearing:true` + `criticalPath` but
none of the three. Summary/heartbeat gain `loadBearingGapKeys`,
`loadBearingSoakingKeys`, `loadBearingAcceptedKeys`. Extend `ROW_FIELD_ALLOWLIST` with
all five new row fields (the closed projection must name them or they never leave the
server — the Tier-1 allowlist test).

**`loadBearingGapKeys` is NOT "all unguarded critical paths"** — it is the loud
silent-and-past-grace subset. A load-bearing guard that is loudly unguarded
(`off-runtime-divergent` — the literal load-shed class — `diverged-from-default`,
`missing`, `errored`, `on-stale`) is ALREADY alarming under its own class; G3 does NOT
set `loadBearingGap` there (no double-alarm) but DOES attach the `criticalPath` label to
that emission (§2.3), so the loudest case — the 2026-06-05 runtime-disable incident —
carries "a LOAD-BEARING critical path (X) is down," not a bare generic row.

### 2.3 The surfaced signal (`GuardPostureProbe`) — named class, both paths, no masking

- **New anomaly class `'load-bearing-gap'`** (loud) pushed in BOTH probe paths:
  `evaluateInventory` — after the effective-state switch, `if (row.loadBearingGap)
  push({ class:'load-bearing-gap', key, criticalPath })` (a load-bearing `off:dark-default`
  hits `case 'off'` which only pushes on `diverged-from-default`; `on-dry-run` hits
  `default:break` — so the explicit check is required or the local path emits nothing);
  `evaluateHeartbeat` — read `loadBearingGapKeys` from the compact block,
  `Array.isArray`-guarded (an un-upgraded peer omits it → empty, never a throw).
- **`criticalPath` annotation (both paths):** for ANY anomaly whose guard is
  `loadBearing`, annotate the emission with `criticalPath` — so the label rides the loud
  classes too, not only `load-bearing-gap`.
- **Soaking is a softer, separate surface:** `loadBearingSoaking` does NOT push the loud
  `load-bearing-gap` class. It surfaces on `/guards` and, at most, a low-frequency
  informational "N load-bearing guard(s) soaking (graduating by <date>)" line — it must
  never crowd out or coalesce-away an acute alarm (Bounded Notification Surface).
- **Episode-masking fix (round-2 material — a pre-existing probe weakness G3 must not
  amplify):** `load-bearing-gap` is a DESIGNED long-lived anomaly (the graduate/accept
  decision legitimately takes days), so an open, un-closed episode is normal. Today an
  episode ends only when `current` empties, and while `episodeEmitted` is true a NEW
  anomaly joining `current` triggers no emit and no item update — so a week-old pending
  Gap on guard X would MASK a fresh `off-runtime-divergent` load-shed on guard Y (exactly
  the incident G3 exists to catch). FIX: when `current` gains an anomaly key not yet
  represented in the open episode, RE-EMIT/UPDATE the single item under the same
  `GUARD_POSTURE_HEALTH_KEY` (preserving P17 — still ONE coalesced item, refreshed count +
  key list), rather than staying silent until the set fully clears. Regression test in §5.

The probe raises ONE aggregated, P17-coalesced Attention item — "N load-bearing guard(s)
are dark: <criticalPath list>. Graduate them or record an owned accepted-fallback (A
Dark Feature Guards Nothing)." — never one-per-guard, never a new topic (honors the
one-hub rule). Observe-only: it NEVER gates, blocks, or disables (Signal vs. Authority).

### 2.4 Closing a gap — graduate, soak-out, OR record an owned operator acceptance

The standard's two arms, correctly filed:

- **Graduate** (the primary arm) — flip the guard on (`on-confirmed`): the gap posture
  no longer holds, all three flags clear naturally. Soaking is IN this arm: a
  dry-run-first guard is `loadBearingSoaking` (time-bounded, re-surfaced), and its own
  soak window is the forcing function to graduate; if it stalls past the window it lapses
  to the loud `loadBearingGap` — never silent-forever (the round-2 fix: soak is NOT a
  suppression, it is bounded graduate-arm pressure; Close the Loop).
- **Operator-accept** (the deliberate second arm) — a durable, per-machine,
  operator-authored record: `state/guard-accepted-fallbacks.json`, keyed
  `<machineId>:<guardKey>` → `{ reason, owner, acceptedAt }`. A guard with this record is
  `loadBearingAccepted` (full Gap suppression) and surfaces as a VISIBLE accepted-risk
  row — the risk is acknowledged + owned, never silent. This arm is reserved for a
  GENUINE operator decision, NOT a blanket code default (round-2: a code-shipped
  fleet-wide seed is exactly the "shrug" the standard forbids — so soak is NOT modeled as
  an accept).
- **Operator route (operator-authenticated, not bare Bearer):**
  `POST /guards/:key/accept-fallback { reason }` records it; `DELETE
  /guards/:key/accept-fallback` revokes (re-opening the Gap / Soaking classification). It
  suppresses a SAFETY signal → it requires the **dashboard PIN** (reuse `checkMandatePin`;
  Know Your Principal — a Bearer token cannot accept a risk on the operator's behalf).
  Per-machine (a gap is per-machine). **DELETE scopes to operator records ONLY** — it can
  never touch the manifest soak window (which is a code constant, not an on-disk record),
  so a revoke is unambiguous and reboot-stable (there is nothing to re-seed).

### 2.5 Why this is load-bearing to the PROBE itself

An un-closeable anomaly would hold the probe episode open forever and (pre-fix) mask
every later alert. Two mechanisms keep G3 from breaking the probe it rides: (a) the
operator-accept and graduation both CLEAR `loadBearingGap`, so a resolved guard leaves
`current` and the episode can close; (b) the §2.3 re-emit-on-set-change fix ensures that
even while a long-lived Gap legitimately holds the episode open, a NEW acute anomaly
still refreshes the single item — so a real load-shed is never masked by a pending
decision. Soaking never enters the loud `current` set at all, so it can't hold an episode
open.

### 2.6 Data flow (keeps `deriveGuardRow` pure — round-2 material)

`buildGuardInventory` (the orchestration layer that already assembles snapshot +
bootSnapshot + registry) reads/parses `state/guard-accepted-fallbacks.json` ONCE per
inventory build and threads the resulting `Map<guardKey, {reason,owner,acceptedAt}>` into
each `deriveGuardRow` call via a new `DeriveInput.acceptedFallback` field.
`deriveGuardRow` stays PURE (no `fs`), so its unit-test contract is preserved.
`buildHeartbeatPostureBlock` filters the already-derived rows for the three key-lists —
one read point, no per-guard disk access on the `/guards` hot path.

## 3. Decision points touched

No new block/allow/route gate. G3 adds inventory FLAGS, one probe anomaly class + the
episode re-emit fix, and one PIN-gated ack route that only SUPPRESSES a signal. Judgment
is manifest curation (which guards are load-bearing + each soak window) — frontloaded
(§Frontloaded Decisions), reviewed like any manifest edit.

## 4. Multi-machine posture (mandatory)

Per-machine with a pool read: `loadBearing`/`criticalPath`/`soakWindowDays` are manifest
constants (identical everywhere; a soak window is fleet-uniform, so "defaults-on only
after seeded" is automatically satisfied — the seed is code, atomic with the manifest).
The GAP/SOAKING/ACCEPTED classification is per-machine (a guard dark on the Mini but
on-confirmed on the Laptop is a per-machine truth; an operator-accept on one machine does
not silence the gap on another — each operator decision is local, by design). The
heartbeat carries `loadBearingGapKeys` (+ soaking/accepted), so `GET /guards?scope=pool`
and the Machines tab surface a gap on ANY machine (same path `offDeviantKeys` rides; peer
read Array.isArray-guarded). The probe item is pool-coalesced. Single-machine install =
per-machine keying degrades to the lone machine; no behavior change.

## 5. Tests

- `loadBearing-dark-default-off-not-accepted-sets-loadBearingGap` (core loud).
- `non-loadBearing-dark-default-off-stays-quiet`.
- `loadBearing-on-dry-run-within-soak-window-sets-loadBearingSoaking-not-gap`.
- `loadBearing-on-dry-run-PAST-soak-window-lapses-into-loadBearingGap` (the expiry — no
  silent-forever).
- `loadBearing-on-confirmed-sets-flag-and-criticalPath-but-none-of-the-three`.
- `operator-accept-sets-loadBearingAccepted-and-clears-gap` (+ visible accepted-risk row).
- `operator-DELETE-revoke-reopens-gap-and-survives-reboot` (DELETE touches only the JSON
  operator record; manifest soak is untouched → no re-seed clobber).
- `deriveGuardRow-stays-pure-accept-map-threaded-via-DeriveInput` (no fs in the pure fn;
  buildGuardInventory does the single read).
- `probe-episode-reemits-when-current-gains-a-new-key` AND
  `new-off-runtime-divergent-surfaces-while-a-load-bearing-gap-episode-is-open` (the
  masking regression — the deepest round-2 finding).
- `criticalPath-label-travels-on-off-runtime-divergent` (+ missing/errored/on-stale).
- `soaking-does-not-push-loud-load-bearing-gap-class` (softer surface only).
- `evaluateInventory-pushes-load-bearing-gap-class` + `evaluateHeartbeat-reads-loadBearingGapKeys-arrayguarded`.
- `accept-fallback-route-requires-dashboard-pin` (Bearer-only rejected).
- `allowlist-projection-includes-all-five-loadBearing-fields`.
- `criticalPath-required-when-loadBearing-true` (manifest lint).
- Multi-machine: `dark-unaccepted-on-one-machine-surfaces-in-pool-view`;
  `operator-accept-on-one-machine-does-not-silence-peer-gap`.
- Migration parity: `guardManifest-loadBearing-additions-reach-existing-agents`; Tier-3
  feature-alive e2e asserts `/guards` returns the new fields (not 503) + the accept route
  is mounted.

## 6. Rollback / rollout

The classification (flags + summary + allowlist + criticalPath annotation), the
accept-fallback route, and the probe episode re-emit fix ship ALWAYS-ON as pure
observability/robustness — additive, never gating (byte-identical `/guards` for a
consumer that ignores the new fields; the re-emit fix strictly improves an existing
weakness). The PROBE alert on `load-bearing-gap` ships behind the existing
GuardPostureProbe enablement + a `monitoring.guardPostureProbe.alertLoadBearingGaps`
sub-flag (soak-gated default-on is automatic — soak windows are code constants atomic
with the manifest). Rollback = drop the sub-flag; `/guards` keeps the classification. No
new notification surface (rides the probe's existing one).

**Agent Awareness (mandatory).** Extend `src/scaffold/templates.ts` → `generateClaudeMd()`,
the existing "Guard Posture — which safety systems are genuinely on (`GET /guards`)"
section, with the `loadBearingGap` / `loadBearingSoaking` / `loadBearingAccepted` /
`criticalPath` vocabulary and the "graduate it, let it soak-out, OR record an owned
accepted-fallback" resolution — so a deployed agent can explain a "load-bearing guard is
dark" attention item and drive its resolution. Migration parity: the template change
reaches existing agents via `migrateClaudeMd()` (content-sniffed); manifest additions
reach them because the manifest ships as code.

## Frontloaded Decisions

1. **FLAGS, not a new `GuardEffectiveState`** — orthogonal flags are additive and cannot
   regress the nine-state precedence contract.
2. **Curated `loadBearing` list + per-guard soak window, not inferred** — fixed criterion
   ("user-visible silent degradation if off"); each entry declares `criticalPath` +
   `soakWindowDays` + `declaredLoadBearingAt`, reviewed like any manifest edit. A wrong
   entry is observe-only, reversible by a manifest edit, soak-gated — so the LIST is cheap.
3. **BOTH standard arms implemented (graduate + operator-accept)** — surfacing without a
   close path trains the operator to ignore then disable the class. Accept is durable,
   owned, VISIBLE, per-machine — never silent.
4. **Accept route is dashboard-PIN-gated** — it suppresses a safety signal; a Bearer token
   cannot accept a risk on the operator's behalf (Know Your Principal). Reuses `checkMandatePin`.
5. **`criticalPath` travels on ALL anomalies; `loadBearingGap` is the loud silent subset**
   — the loud states already alarm; G3 annotates rather than double-alarms, and
   `loadBearingGapKeys` is never misread as "all unguarded."
6. **Soak is the GRADUATE arm, time-bounded, NOT an accept (round-2 core fix)** — a
   dry-run-first load-bearing guard is `loadBearingSoaking` within a manifest
   `soakWindowDays`, re-surfaced on cadence, and LAPSES into the loud `loadBearingGap`
   when the window expires. It is never modeled as a code-shipped accept (which would be
   the "shrug" the standard forbids and would silence it forever).
7. **Observe-only, rides the existing probe surface** — Signal vs. Authority; no new topic.
8. **Always-on classification + accept route + episode-fix; opt-in alert** — flags/route
   are pure observability; only the proactive item is flag-gated.
9. **`deriveGuardRow` stays PURE (round-2 fix)** — the accept map is read ONCE in
   `buildGuardInventory` and threaded via `DeriveInput`; no `fs` in the pure function.
10. **Probe re-emits on anomaly-set change (round-2 fix)** — a long-lived `load-bearing-gap`
    episode must not mask a later acute load-shed; a new key refreshes the one P17 item.
11. **Soak window = manifest constant; DELETE = operator records only** — fleet-uniform,
    reboot-stable, DELETE-unambiguous (nothing to re-seed).

## Open questions

None.

> All round-2 findings — `deriveGuardRow` purity (Decision 9 / §2.6), soak-as-graduate-arm
> with a bounded window (Decision 6 / §2.2-2.4), the on-dry-run trigger unified on the soak
> window (§2.2), seed-storage + DELETE (Decision 11 / §2.4), and the episode-masking fix
> (Decision 10 / §2.3, §2.5) — are resolved into the design + Frontloaded Decisions. The
> initial load-bearing manifest set + per-guard soak windows (Decision 2) are a reviewed
> curation task finalized at implementation against the current manifest — a frontloaded
> task with a fixed criterion, not an open question.
