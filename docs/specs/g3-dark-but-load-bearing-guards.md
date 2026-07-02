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
feature. It sits quiet — yet the critical path it should guard runs UNGUARDED. This is
the failure the ratified standard **"A Dark Feature Guards Nothing"** names: *a
load-bearing path depending on a dark/disabled feature must force a decision — graduate
it, OR record an owned operator acceptance (a recorded decision with an owner, not a
shrug) — never sit silently dark.* The 2026-07-01 silent-loss postmortem is the case
study: guards that would have caught the incident shipped dark, and nothing surfaced
that a critical path (operator message delivery) depended on them.

Today the inventory cannot even EXPRESS "this dark feature is load-bearing." G3 gives the
standard a structural arm at the guard layer — implementing BOTH resolution arms
(graduate / accept), keeping a soaking guard in the graduate arm with re-surfacing
pressure, and (per round-3 adversarial grounding) landing its alert on a channel that
cannot mask an acute load-shed.

## 2. Design

**Add a `loadBearing` declaration + a bounded `soakWindowDays` to the guard manifest.
Classify a load-bearing guard in a silent-unguarded posture into ONE of three states —
`loadBearingGap` (loud, on its OWN attention channel), `loadBearingSoaking` (graduate
arm; surfaced on `/guards` only, no attention item), `loadBearingAccepted` (owned
operator acceptance, full suppression + visible accepted-risk row). Make `criticalPath`
travel on EVERY anomaly of a load-bearing guard. Pure classifier, observe-only.**

### 2.1 Manifest declaration (`src/monitoring/guardManifest.ts`)

```ts
loadBearing?: boolean;          // a critical path depends on this guard
criticalPath?: string;         // REQUIRED when loadBearing — the path (e.g. "operator message delivery")
soakWindowDays?: number;       // graduated-rollout soak budget, days from declaredLoadBearingAt (manifest
                               // constant). 0/absent ⇒ no grace → on-dry-run is immediately a Gap.
declaredLoadBearingAt?: string; // ISO date the flag was added (manifest constant)
```
**Manifest lint (mirrors the existing `criticalPath`-required lint):** when
`loadBearing` is true, `criticalPath` is required; and when `soakWindowDays > 0`,
`declaredLoadBearingAt` is REQUIRED and must be a valid ISO date. If it is absent or
malformed at runtime, the soak clause cannot be evaluated → the guard falls to the loud
`loadBearingGap` (the SAFE, loud direction — never silently non-soaking from a typo).
Curating the load-bearing set + each soak window is a reviewed manifest edit, not
inferred.

### 2.2 Classifier surface (`guardPostureView.deriveGuardRow`) — PURE, three states

`deriveGuardRow` is a PURE, no-I/O function and stays so. The per-machine operator-accept
map and `now` are threaded in via `DeriveInput` (§2.6); `soakWindowDays` +
`declaredLoadBearingAt` are manifest constants reachable via the registry. The nine
`GuardEffectiveState` values + the precedence table are UNCHANGED — G3 adds orthogonal
FLAGS. `deriveGuardRow` sets these **SIX** new row fields:
```ts
loadBearing?: true;               // mirrored from the manifest
criticalPath?: string;           // present for ANY posture of a load-bearing guard
loadBearingGap?: true;           // LOUD: silently unguarded, past soak, not accepted
loadBearingSoaking?: true;       // GRADUATE arm: on-dry-run within the soak window
loadBearingAccepted?: true;      // owned operator acceptance recorded (this machine)
acceptedFallbackReason?: string; // the operator's recorded reason (the VISIBLE accepted-risk row)
```
For a load-bearing guard in a SILENT-unguarded posture (`off:dark-default` or
`on-dry-run`), exactly one of Gap/Soaking/Accepted is set, by this precedence on a single
`now`:
1. operator-accept recorded → `loadBearingAccepted` (+`acceptedFallbackReason`); full Gap
   suppression; VISIBLE accepted-risk row.
2. else `on-dry-run` AND within `soakWindowDays` of `declaredLoadBearingAt` →
   `loadBearingSoaking` (graduate arm). Lapses to `loadBearingGap` when the window ends
   (monotonic on `now` — one transition, never reverts).
3. else → `loadBearingGap` (loud).
A load-bearing guard that is `on-confirmed` sets `loadBearing` + `criticalPath` only.

**Extend `ROW_FIELD_ALLOWLIST` with ALL SIX fields by name** — `loadBearing`,
`criticalPath`, `loadBearingGap`, `loadBearingSoaking`, `loadBearingAccepted`,
`acceptedFallbackReason` (round-3: the earlier "five" miscount would strip
`acceptedFallbackReason`, rendering the accepted-risk row with no reason — silently
hollowing the owned-acceptance arm; the projection is closed, so an unnamed field never
leaves the server). Summary/heartbeat gain `loadBearingGapKeys`,
`loadBearingSoakingKeys`, `loadBearingAcceptedKeys`.

**`loadBearingGapKeys` is the loud silent-and-past-grace subset, NOT "all unguarded."** A
load-bearing guard that is loudly unguarded (`off-runtime-divergent` — the load-shed
class — `diverged-from-default`, `missing`, `errored`, `on-stale`) already alarms under
its own class; G3 does not set `loadBearingGap` there (no double-alarm) but DOES attach
the `criticalPath` label to that emission (§2.3).

### 2.3 The surfaced signal (`GuardPostureProbe`) — separate channel, no masking

- **New anomaly class `'load-bearing-gap'`** (loud), pushed in BOTH probe paths:
  `evaluateInventory` — after the effective-state switch, `if (row.loadBearingGap)
  push({ class:'load-bearing-gap', key, criticalPath })` (a load-bearing `off:dark-default`
  hits `case 'off'` which only pushes on `diverged-from-default`; `on-dry-run` hits
  `default:break` — so the explicit check is required); `evaluateHeartbeat` — read
  `loadBearingGapKeys` from the compact block, `Array.isArray`-guarded (un-upgraded peer →
  empty). For a peer gap, `criticalPath` is looked up from the local `GUARD_MANIFEST` (a
  fleet-uniform constant, valid per §4).
- **criticalPath annotation** rides ANY anomaly of a load-bearing guard (both paths) — so
  the loud classes carry "a LOAD-BEARING critical path (X) is down," not a bare row.
- **Own attention channel (round-3 masking fix).** `load-bearing-gap` is a DESIGNED,
  long-lived anomaly (the graduate/accept decision legitimately takes days), so its
  episode stays open for a long time. The attention funnel (`createAttentionItem`) is
  CREATE-IF-ABSENT by item id, and the agent-health lane suppresses a same-`healthKey`
  re-escalation for ~30 min — so a long-lived gap episode sharing the GENERIC
  `GUARD_POSTURE_HEALTH_KEY` would MASK a later acute load-shed on another guard (the
  2026-06-05 incident G3 exists to catch): the fresh anomaly would hit the same open
  episode id and be silently dropped. FIX: `load-bearing-gap` rides its OWN dedicated
  `GUARD_POSTURE_LOADBEARING_HEALTH_KEY`, SEPARATE from the generic guard-posture episode.
  The acute classes keep their existing episode/channel, so an acute load-shed surfaces
  independently regardless of a load-bearing-gap episode being open. Two coalesced health
  keys, each ONE item — never a per-guard flood, never a new topic (Bounded Notification
  Surface, one-hub rule). (This SUPERSEDES the round-2 "re-emit under the same healthKey"
  idea, which round-3 grounding proved inert against the create-if-absent funnel.)
- **Soaking pushes NO attention item.** `loadBearingSoaking` surfaces on `/guards` +
  `loadBearingSoakingKeys` and at most a low-frequency informational LOG line — it never
  raises an attention item, so it needs no health key and cannot crowd an alarm.

Observe-only: the probe only ever calls the attention funnel; it NEVER gates, blocks, or
disables (Signal vs. Authority).

### 2.4 Closing a gap — graduate, soak-out, OR record an owned operator acceptance

- **Graduate** (primary) — flip the guard on (`on-confirmed`): all flags clear. Soaking is
  in this arm: a dry-run-first guard is `loadBearingSoaking` within its bounded window and
  LAPSES to the loud `loadBearingGap` if it stalls past it — the Close-the-Loop forcing
  function, never silent-forever.
- **Operator-accept** — a durable, per-machine, operator-authored record:
  `state/guard-accepted-fallbacks.json`, keyed `<machineId>:<guardKey>` → `{ reason, owner,
  acceptedAt }`, → `loadBearingAccepted` + a VISIBLE accepted-risk row. Reserved for a
  GENUINE operator decision, never a code default (a fleet-wide seed would be the "shrug"
  the standard forbids).
- **Route (operator-authenticated):** `POST /guards/:key/accept-fallback { reason, owner }`
  — BOTH `reason` and `owner` are REQUIRED body fields (round-3: the record needs `owner`
  and the PIN proves only "a PIN-holder," not a named operator, so `owner` cannot be
  derived — the agent must be handed it, or the "owned, not a shrug" thesis collapses to a
  guessed constant). `acceptedAt` is the server timestamp. `DELETE
  /guards/:key/accept-fallback` revokes. Requires the **dashboard PIN** (`checkMandatePin`;
  Know Your Principal — a Bearer token cannot accept a risk for the operator). Per-machine.
  DELETE scopes to the JSON operator record ONLY — it never touches the manifest soak
  constant (nothing to re-seed; reboot-stable).

### 2.5 Why the masking channel-split matters

An un-closeable/long-lived anomaly holding an episode open is normal for
`load-bearing-gap` (the decision takes days). The round-2 "re-emit" idea could not land
fresh content through the create-if-absent funnel (round-3 finding), so the real fix is
the SEPARATE health key (§2.3): the acute-load-shed classes retain their own episode +
emission channel, so a genuine load-shed on guard Y is surfaced even while a
`load-bearing-gap` episode on guard X has been open for a week. Soaking never enters any
loud `current` set (it pushes no attention item), so it cannot hold an episode open.

### 2.6 Data flow (both `deriveGuardRow` AND `buildGuardInventory` stay PURE)

`guardPostureView.ts` is contract PURE/no-I/O — `buildGuardInventory` today receives ALL
disk-resolved state (config snapshot, boot snapshot, registry) via `opts` from its caller
`getLocalPosture` (the route/orchestration layer), and touches no `fs`. So the
accepted-fallback map is read/parsed by the CALLER (`getLocalPosture` / the route handler,
where `resolveGuardConfigSnapshot` + `readGuardPostureBootSnapshot` already run) and
threaded into `buildGuardInventory` via a new `opts` field + into each `deriveGuardRow`
via `DeriveInput` (mirroring exactly how `bootSnapshot` is resolved-by-caller-and-passed).
`now` is threaded the same way. NEITHER `deriveGuardRow` NOR `buildGuardInventory` gains
an `fs` call (round-3: the round-2 wording relocated the I/O into `buildGuardInventory`,
which is itself pure — the correct layer is the caller). `buildHeartbeatPostureBlock`
filters the already-derived rows for the three key-lists. One read point, no per-guard
disk on the `/guards` hot path.

## 3. Decision points touched

No new block/allow/route gate. G3 adds inventory FLAGS, one probe anomaly class on its own
health key, and one PIN-gated ack route that only SUPPRESSES a signal. Judgment is
manifest curation (load-bearing set + soak windows) — frontloaded, reviewed like any
manifest edit.

## 4. Multi-machine posture (mandatory)

Per-machine with a pool read: `loadBearing`/`criticalPath`/`soakWindowDays`/
`declaredLoadBearingAt` are manifest constants (identical fleet-wide — so "defaults-on
only after seeded" is automatic, the constant ships atomic with the manifest, and a peer's
`criticalPath` is looked up from the local manifest). GAP/SOAKING/ACCEPTED classification
is per-machine (a guard dark on the Mini but on-confirmed on the Laptop is a per-machine
truth; an operator-accept on one machine does not silence a peer's gap — each decision is
local). The heartbeat carries the three key-lists; `GET /guards?scope=pool` + the Machines
tab surface a gap on ANY machine (same path `offDeviantKeys` rides; peer read
Array.isArray-guarded). The `load-bearing-gap` probe item is pool-coalesced on its own
health key. Single-machine install degrades cleanly.

## 5. Tests

- `loadBearing-dark-default-off-not-accepted-sets-loadBearingGap`.
- `non-loadBearing-dark-default-off-stays-quiet`.
- `loadBearing-on-dry-run-within-soak-window-sets-loadBearingSoaking-not-gap`.
- `loadBearing-on-dry-run-PAST-soak-window-lapses-into-loadBearingGap`.
- `soakWindowDays>0-with-absent-or-malformed-declaredLoadBearingAt-falls-to-gap` (the lint
  fallback — safe/loud, never silently non-soaking).
- `loadBearing-on-confirmed-sets-flag-and-criticalPath-only`.
- `operator-accept-requires-owner-and-reason-and-clears-gap` (+ the VISIBLE accepted-risk
  row carries the reason).
- `accept-fallback-route-requires-dashboard-pin` (Bearer-only rejected); `owner-missing-rejected`.
- `operator-DELETE-revoke-reopens-gap-and-survives-reboot`.
- `deriveGuardRow-AND-buildGuardInventory-stay-pure-accept-map-threaded-by-caller` (no fs
  in either; `getLocalPosture` does the single read).
- `load-bearing-gap-rides-its-own-health-key` AND
  `acute-off-runtime-divergent-surfaces-while-a-load-bearing-gap-episode-is-open` — the
  masking regression, driven against the REAL `createAttentionItem` funnel (assert guard Y
  is observably surfaced, not merely that emit was called).
- `soaking-pushes-no-attention-item` (only `/guards` + log).
- `criticalPath-label-travels-on-off-runtime-divergent` (+ missing/errored/on-stale).
- `evaluateInventory-pushes-load-bearing-gap-class` + `evaluateHeartbeat-reads-loadBearingGapKeys-arrayguarded`.
- `allowlist-projection-includes-all-SIX-loadBearing-fields`.
- `criticalPath-and-declaredLoadBearingAt-manifest-lints`.
- Multi-machine: `dark-unaccepted-on-one-machine-surfaces-in-pool-view`;
  `operator-accept-on-one-machine-does-not-silence-peer-gap`.
- Migration parity: `guardManifest-loadBearing-additions-reach-existing-agents`; Tier-3
  feature-alive e2e asserts `/guards` returns the six fields (not 503) + the accept route
  is mounted.

## 6. Rollback / rollout

Classification (flags + summary + allowlist + criticalPath annotation), the accept route,
and the separate-health-key channel ship ALWAYS-ON as pure observability — additive, never
gating (byte-identical `/guards` for a consumer ignoring the new fields). The PROBE alert
on `load-bearing-gap` ships behind the existing GuardPostureProbe enablement + a
`monitoring.guardPostureProbe.alertLoadBearingGaps` sub-flag (soak-gated default-on is
automatic — soak windows are code constants). Rollback = drop the sub-flag; `/guards`
keeps the classification. No new notification surface beyond the one dedicated health key.

**Agent Awareness (mandatory).** Extend `src/scaffold/templates.ts` → `generateClaudeMd()`
(the "Guard Posture — `GET /guards`" section) with the `loadBearingGap` /
`loadBearingSoaking` / `loadBearingAccepted` / `criticalPath` vocabulary and the
"graduate, let it soak-out, OR record an owned accepted-fallback (with an owner)"
resolution. Migration parity via `migrateClaudeMd()` (content-sniffed); manifest additions
reach existing agents because the manifest ships as code.

## Frontloaded Decisions

1. **FLAGS, not a new `GuardEffectiveState`** — additive; cannot regress the nine-state contract.
2. **Curated `loadBearing` list + per-guard soak window** — fixed criterion; each entry
   declares `criticalPath` + `soakWindowDays` + `declaredLoadBearingAt`; observe-only +
   soak-gated, so the list is cheap/reversible by manifest edit.
3. **BOTH standard arms (graduate + owned operator-accept)** — surfacing without a close
   path trains ignore-then-disable; accept is durable, owned, VISIBLE, per-machine.
4. **Accept route is dashboard-PIN-gated** — suppresses a safety signal (Know Your Principal).
5. **`criticalPath` travels on ALL anomalies; `loadBearingGap` is the loud silent subset.**
6. **Soak is the GRADUATE arm, time-bounded, not an accept** — `loadBearingSoaking` within
   a manifest window, lapses to the loud Gap at window end; never a code-shipped shrug.
7. **Observe-only** — Signal vs. Authority; no gating.
8. **Always-on classification/route/channel; opt-in alert.**
9. **Both `deriveGuardRow` AND `buildGuardInventory` stay PURE (round-3 fix)** — the caller
   (`getLocalPosture`) reads the accept file once and threads the map + `now` via `opts`/
   `DeriveInput`; no `fs` in either function.
10. **`load-bearing-gap` rides its OWN health key (round-3 masking fix)** — separate from
    the generic guard-posture episode, so a long-lived gap episode cannot mask an acute
    load-shed through the create-if-absent attention funnel. Supersedes the inert
    re-emit-under-same-key idea; soaking pushes no attention item at all.
11. **Soak window = manifest constant; DELETE = operator records only** — reboot-stable.
12. **`owner` is a REQUIRED accept-route field (round-3 fix)** — the PIN proves a PIN-holder,
    not a named operator; `owner` cannot be derived, so it is supplied and written to the
    record + the visible accepted-risk row (else "owned, not a shrug" is a guessed constant).
13. **`declaredLoadBearingAt` lint + absent/invalid → Gap (round-3 fix)** — a typo makes the
    guard loud, never silently non-soaking.

## Open questions

None.

> Every round-3 finding — the masking fix's inertness against the real funnel (Decision 10 /
> §2.3, §2.5), the allowlist six-not-five miscount (§2.2), the `buildGuardInventory` I/O-layer
> error (Decision 9 / §2.6), the `owner` provenance gap (Decision 12 / §2.4), and the
> `declaredLoadBearingAt` lint (Decision 13 / §2.1) — is resolved into the design + Frontloaded
> Decisions. The initial load-bearing manifest set + soak windows (Decision 2) are a reviewed
> curation task finalized at implementation against the current manifest.
