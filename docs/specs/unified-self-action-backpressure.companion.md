# SelfActionGovernor — Normative Implementation Companion (Increment B)

**This document is the IMPLEMENTATION AUTHORITY.** The converged spec
(`unified-self-action-backpressure.md`, CONVERGED round 9, `approved: true`) is the design-of-record and
audit trail; a builder implements FROM THIS FILE. Where this file is silent, consult the spec's normative
sections — never its provenance sections. Every clause here traces to a finding id in the spec.

**Ship scope of Increment B:** the single-process governor, OBSERVE-ONLY on every class, fleet-dark per the
graduated ladder. Pool-shared ENFORCE (the composed lease-slice deployment) is explicitly OUT of this
increment — it is the six-deliverable residual behind its own review (§10). No enforce flip happens in this
increment; the flip is the operator's per-class action later (FD8), gated by FD12.

---

## 1. Terminology (mechanical)

- **controller** — one of ~23 registered emit-site owners of a self-triggered action (kill, swap, notify,
  respawn, …). Identified by `controllerId` (string constant, registry-bound).
- **class** — the policy bundle keyed by `controllerId`.
- **target / targetKey** — the entity acted on, derived ONLY by `<controller>.deriveTargetKey(ctx)` →
  `{ key, classId, keyIsVolatile }` (mirrors the deployed `ExternalHogKillLedger` triple).
- **window** — a fixed-bucket sliding count window per class (`windowMs`); no epoch reset for relief.
- **episode** — a latched span (demote episode, errored episode, flip episode) with open/close audit rows.
- **P17 funnel** — `AttentionTopicGuard.decide()` → allow|coalesce; the only path for operator notices.
- **P19 brakes** — max-attempts / backoff / breaker / flap-latch, in-process.
- **heal exhaustion** — a self-heal (e.g. demote→re-promote) failing N consecutive cycles; only then may a
  recoverable-class notice reach the operator.
- **observe / enforce / demoted** — per-class mode. observe: record would-verdicts, always allow. enforce:
  verdicts bind. demoted: enforce class knocked back to observe by a level trigger (FD9 / runtime gate).
- **origin** — `'self' | 'principal'`. principal = human-tier authenticated (see §4).

## 2. API contract

```ts
// Module-scope, once per controller file (single-mint, process-global — §5.3):
const gov = governor.for(controllerId);            // raw string admit at emit sites is LINT-FORBIDDEN

gov.admit(targetKey: DerivedTarget, opts?: AdmitOpts): Admission          // async classes
gov.admitSync(targetKey: DerivedTarget, opts?: AdmitOpts): Admission      // zero-I/O classes only

type Admission =
  | { outcome: 'allow';    token: AdmissionToken; reason: SubMechanism }
  | { outcome: 'coalesce'; reason: SubMechanism }
  | { outcome: 'queue';    reason: SubMechanism; retryAfterMs?: number };

// Privileged, SEPARATE API — importable ONLY by the enumerated provenance-setting modules (§4):
governor.principalAdmit(surface: PrincipalSurface, action: ActionRef): Admission  // ALWAYS allow + audit
```

- `Admission.reason` (`SubMechanism`) NAMES the deciding layer: `per-target-ceiling | total-ceiling |
  census-scale | rate-bucket | breaker | stale-projection | queue-full | lane-floor | observe-would-deny |
  rehydrated-window | disabled-passthrough | errored-open | principal-lane`. A post-restart verdict whose
  window includes rehydrated pre-restart admissions uses `rehydrated-window` in the reason detail.
- `AdmissionToken`: opaque, bound `(controllerId, targetKey, classId, nonce)`, TTL'd; runtime
  consume-once at the protected sink is the AUTHORITY (compile-time type = defense-in-depth). A sink pins
  its expected controllerId module-side and rejects a token minted for any other controller.
- Ordinary handles CANNOT express `origin:'principal'` — they stamp `'self'` unconditionally.

## 3. Policy schema + defaults

```ts
ControllerPolicy = {
  controllerId, actionVerb,
  direction: 'relief' | 'amplifying' | 'neutral',
  resource:  'hardware-bound' | 'pool-shared',
  failDirection: 'closed-queue' | 'open-coalesce' | 'open-audited',   // relief classes = open-audited
  perTargetCountCeiling, totalCountCeiling,        // seeded from registry perTargetBoundK / boundK
  rateBucket: { ratePerWindow, windowMs, refill },
  concurrencyCap,
  breaker: { failThreshold, cooldownMs, flapWindowMs },
  staleTtlMs,
  queueMaxDepth,          // per (controller, target) coalesced depth
  queueMaxTargets,        // per controller DISTINCT-target queue ceiling (default 64)
  perTargetEvict: { ttlMs, maxEntries },
  amplifying?: { projectPressure },                // raw {value, asOf, confidence} only
  eternalSentinel?: { rateFloorMs },               // code floor: 300_000 ms
}
```

Defaults are CODE constants; config carries sparse per-class overrides, validated AT LOAD (malformed →
code default + audit row; never throw-in-admit). `migrateConfig` writes NOTHING.

Illustrative default table (all FD11-class config-overridable unless marked ⚠):

| constant | default |
|---|---|
| `age-kill` totalCeiling | census-scaled: max(60, 15% of live sessions)/60-min window |
| `age-kill` perTargetCeiling | 5; `external-hog` 3; `swap` 3/account; `respawn-crashloop` 3/session |
| `swap` totalCeiling | 8 / 45 min; staleTtl 60 s |
| census fraction k | 15% |
| ⚠ `censusAbsoluteMax` | 4× configured session cap — session-cap-derived value may only TIGHTEN below the hard code ceiling; overrides ride the audited per-class surface only |
| `queueMaxTargets` | 64 |
| ⚠ last-resort errored floor | per-class: 4× the class's static floor per window (age-kill ≈ 240/h) — NOT config-overridable, reads NO config, tightenable only in code |
| eternalSentinel `rateFloorMs` floor | 300,000 ms |
| demote-alarm exhaustion N | 3 clean-cooldown windows |
| eager-flush admission delta | 10 admissions (debounced ≥ 1 s) |
| flip-episode latch window | 10 min |
| errored-audit first-N | 20 verbatim rows |
| observe-limbo nudge | 30 d after promotion criterion met |
| principal volume-anomaly threshold | 30 admits/(surface, 10-min window); re-arm after one clean window |

## 4. Principal provenance (FD13)

- `origin:'principal'` REQUIRES a human-tier signal: dashboard-PIN-authenticated session,
  MessageSentinel-verified REGISTERED sender, or mandate-verified principal. A bare Bearer API call is
  `'self'` (the agent holds Bearer). Build task: make the PIN-authed dashboard session distinguishable
  from bare-Bearer at `DELETE /sessions/:id` and `POST /sessions/:name/remote-close`.
- `principalAdmit` importable only by the enumerated module allowlist (= the dual-use sink entry
  surfaces + MessageSentinel interceptor); the `origin:'principal'` literal and the privileged import are
  lint-forbidden elsewhere; the Tier-3 inventory asserts allowlist == dual-use sink list.
- Principal admission: always-allow, always-audited (per-admit rows — the ONE deliberate per-event audit
  carve-out), volume-anomaly page (episode-latched, HIGH, P17-bound), NEVER paced — exempt from ceilings,
  from the errored-open path, and from the last-resort floor; a throwing `principalAdmit` resolves OPEN.
- Honesty: the PIN tier defeats buggy runaway loops, not a deliberately adversarial self; the covering
  controls are the audit + volume page. Verifier-dark valve layering: conversational instruction (primary)
  → dashboard/API config surface (§11) → raw config-file edit (verifier-independent floor).

## 5. State model

### 5.1 In-memory admission state
Fixed-bucket sliding windows per class; recency-aware evictable per-target maps (capped
`perTargetEvict.maxEntries`; full-map + new distinct target ⇒ fail closed, no eviction of active
entries); totals tracked independently of eviction. Zero-I/O `admitSync` for `notify`/`age-kill`-class
paths; host-file CAS only for genuinely cross-PROCESS classes (dead-holder/TTL reclaim mandatory).

### 5.2 Durable snapshot (FD14)
- Flush: bounded cadence PLUS async eager flush — admission-delta (debounced ≥1 s), half-ceiling crossing
  (once/window, debounce-exempt), FIRST post-rehydrate admission (IMMEDIATE, leading-edge), graceful
  shutdown; flush barrier before consuming a token for any governor-process-killing action.
- Rehydrate: recency-validated (drop state older than the largest class window, `state-reset` row on
  non-trivial drops); pessimistic carry-forward after unclean shutdown, with a NON-ZERO floor when
  last-flushed rate ≈ 0 but prior-enforcement evidence exists.
- Missing/corrupt snapshot WITH prior flush evidence (telemetry aggregates high-water) ⇒ conservative
  posture (static rate floor, one window) + loud `state-reset` row + attention signal; genuinely fresh
  install ⇒ silent empty. Accepted residual: coordinated deletion of snapshot + aggregates (+ transitions
  audit, third witness) degrades to fresh-install posture (local-fs adversary, accepted).
- Files: machine-local; snapshot AND telemetry-aggregates file join `BLOCKED_PATH_PREFIXES`. Standard-A:
  hardware-bound content = `machine-local-justification: hardware-bound-resource`; pool-shared classes'
  buckets = `unified` (local half of the FD15-replicated surface).

### 5.3 Process-global anchor + single-mint (ADV8-1 / ADV9-1)
The mint registry AND the admission-state anchor live behind ONE `Symbol.for('instar.selfActionGovernor')`
key on `globalThis`, storing a MINIMAL claim surface (not raw mutable maps). Lifecycle: INIT-ONCE — the
first claimant initializes, rehydrates, and owns the single flush loop; a later claimant ATTACHES
read-write, never re-initializes, never starts a second flusher. A duplicate `governor.for(id)` claim
fails LOUDLY: controller-scoped errored posture (never process-fatal), `mint-collision` audit row; the
losing claimant's dead handles resolve through the per-class fail direction. Provide a
test-only dispose/reset (key-salt or explicit release) so the mandated bounce/dual-load fixtures can
re-instantiate within one process (SC9-1).

### 5.4 Queue
Bounded both axes (`queueMaxDepth` coalesced per-lane; `queueMaxTargets` distinct-target). Drain:
re-admit + re-project + re-run the controller's eligibility predicate + incarnation-fence check
(reject-on-mismatch = audited drop); BOTH-unavailable (no fence AND predicate un-evaluable) = audited
drop. Fairness: age-based promotion (reserved slice = config variant). Intents are in-memory BY DESIGN
(level-triggered classes regenerate); ANY boot with non-zero last-known population writes ONE
`restart-shed` row (clean/unclean-tagged). Enqueue path is minimal (pre-allocated, policy-free, no I/O);
double failure = audited drop + `enqueue-drop` class in the dead-letter coalesced notice.

## 6. Fail matrix (governor ERROR / disabled)

| class family | on admit() throw (enabled) | notes |
|---|---|---|
| cost/safety (`swap`, `respawn-crashloop`) | CLOSED-to-QUEUE | never allow, never strand |
| disruption-only (`notify`) | open-but-coalesce | |
| non-recovery relief (`kill`, `reaper`, `session-close`) | OPEN-with-audit | first-N + aggregated rows; paced by the self-origin per-class last-resort floor; errored episode = CRITICAL alarm |
| `respawn-recovery` | OPEN unconditionally | no blocking bound anywhere; give-up = ResumeQueue cap + reconciler P19 (registry-declared `delegatedGiveUp`, fixture-driven) |
| `origin: 'principal'` | OPEN unconditionally | exempt from errored path AND floor; volume page only |
| `emergencyDisable: true` | allow-token pass-through (all classes) | the ONLY unconditional allow-token path; flip = episode-latched HIGH item, immediate |

## 7. Census discipline (relief ceiling input)

Cached integer, sampled OFF the hot path (window roll + slow reaper/heartbeat tick), NEVER in
admit/admitSync. Ceiling computed AT window roll; mid-window re-sample may only WIDEN. Source must be
governor-owned and INDEPENDENT of the governed controller's candidate enumeration. Rides
`{value, asOf, confidence}`; widening requires fresh+confident; stale/unavailable/low-confidence ⇒ static
floor. `k% × census` clamped by `censusAbsoluteMax`; clamp-hit writes an audit row.

## 8. Operator notices (six; all Standard-B / P22)

| notice | trigger gate | dedupe-key | severity | latency | audit row |
|---|---|---|---|---|---|
| demote alarm | heal EXHAUSTION (N failed cooldowns / flap / co-occurring hard-floor) | (controllerId, episodeId) | recoverable | ≤120 s past exhaustion | demote/re-promote latch |
| dead-letter shed (+ `enqueue-drop`) | any shed | (controllerId, windowId), coalesced enumeration | per-class (swap=HIGH immediate; coalescible=recoverable) | one funnel tick | dead-letter shed |
| errored-posture alarm | errored episode OPEN | (governor, erroredEpisodeId) | CRITICAL while any relief class enforces | one funnel tick | errored-episode open/close |
| emergencyDisable flip | any flip | (flipEpisodeId), N flips → one item | HIGH on disable | immediate | emergencyDisable flip |
| principal volume page | anomaly episode per surface | anomaly episode | HIGH | one funnel tick | principal-volume-anomaly |
| observe-limbo nudge | 30 d past criterion-met, one-shot; INVERSE: sustained would-deny > flip floor on no-bespoke-brake controller | (controllerId), coalesced | routine | one tick past threshold | observe-limbo |

Transient self-heals (demote→clean re-promote) are audit-only. All ride the P17 funnel.

## 9. Enforcement tooling

- `emit-without-admit` lint: scan scope = CODEBASE-WIDE handle USAGE over `src/` — `governor.for()` AND
  `admit()` on an imported handle; usage in a file without a matching `@self-action-controller` marker
  fails; exempt-lane handles never exported (or passed as a value — SEC9-1) beyond that controller's
  allowlisted files. Marker-id uniqueness enforced. `models:` promoted to a lint-asserted binding via a
  parseable path FIELD (supports multiple markers/file — PromiseBeacon hosts two controllers). Self-scope:
  the governor module, the enumerated `principalAdmit` surfaces, and `src/testing/selfActionRegistry.ts`
  ride the per-controller file allowlist (INT9-2).
- Exempt-lane membership (`respawn-recovery`, `eternalSentinel`): enumerated code allowlist; each member
  declares `delegatedGiveUp`; ratchet fixture drives that cap to trip.
- Retrofit is ADDITIVE at every rung: no existing bespoke brake is removed at any point, including
  enforce graduation (LA8-1).

## 10. Guard posture, coherence, and the deferred pool residual <!-- tracked: CMT-1911 -->

- `GUARD_MANIFEST` entry with SYNTHETIC enabled-polarity `configPath:
  'intelligence.selfActionGovernor.enabled'` (`loadBearing: true`) + a hand-wired `extractGuardPosture`
  branch computing `enabled = emergencyDisable !== true`.
- `COHERENCE_CRITICAL_FLAGS`: (a) inverted governor row (`emergencyDisable === true ? 'off' : 'live'`);
  (b) per-class scalar mode rows (`observe|enforce|demoted`) for pool-shared classes, `readSource:
  'live'` against a governor-state accessor ADDED to the caller-injected advert view (view-seam extension
  is part of this deliverable, as are the manifest-ratchet/membership test updates).
- Posture rows carry `overridden: true` + ceiling-vs-default ratio when a numeric override is active;
  `policy-override change` is an audited transition.
- DEFERRED (own review before ANY pool-shared enforce; fleet observe-only until then): (1) durable grant
  store + ledger hygiene (terminal-grant pruning; renewal cadence from slice TTL; O(outstanding) fixture),
  (2) holder-side `slice-renew` handler wiring `authorizeSliceRenew` + `SliceIssuer`, (3) requester-side
  renewal transport around `SliceRenewalControl`, (4) `intelligence.selfActionGovernor.poolCeiling` wiring
  gate + posture, (5) slice-state replication (stateSync-family), (6) governor-side cached-slice read +
  count-budget↔slice-amount denomination mapping. Invariant: ONE grant store + ONE fenced issuer per
  account regardless of gates (both-gates-on test asserts one shared outstanding-total). Pool-shared
  enforce is ALSO a hard RUNTIME gate on replication health + mode coherence + clock-skew green.

## 11. Config surface

- Live-read: `intelligence.selfActionGovernor.emergencyDisable` (the only kill-switch; no env override).
- Sparse per-class overrides under `intelligence.selfActionGovernor.classes.<id>.*`, load-validated,
  audited on change. Exceptions (§3 ⚠): last-resort floor (not overridable), censusAbsoluteMax
  (tighten-only below code ceiling).
- PATCH-config path (Mobile-Complete): implement a NESTED-PATH validator scoped to exactly
  `intelligence.selfActionGovernor` (do NOT allowlist top-level `intelligence` — that would Bearer-expose
  `spawnCap` etc.; INT9-1), with deep-merge for this subtree (the one-level-deep-merge full-block hazard);
  the DISABLE direction (`emergencyDisable: true`) on the API path is dashboard-PIN-gated (ADV9-4 — two
  verifier-independent valves remain, so this costs no emergency availability); re-enable is Bearer-OK.
- CLAUDE.md template section (same PR, + `migrateClaudeMd` patch): the `GET /self-action-governor` route,
  the three proactive triggers ("why did my respawn get held / swap queued / notify folded?"), AND the
  emergencyDisable valve + conversational flip as the operator's mass-incident path (LA9-1).

## 12. Telemetry & routes

In-memory fixed-size aggregates keyed (class × sub-mechanism), flushed on cadence (atomic temp+rename);
transitions-only audit (rows enumerated in the spec §Runtime telemetry — includes errored-episode,
mint-collision, census-clamp, state-reset, restart-shed, observe-limbo, principal-volume-anomaly;
per-admit principal rows are the one carve-out); `GET /self-action-governor` is a LOCK-FREE pure read,
scrubbed (no target identities / absolute quota values); pool-shared class counters exposed via
`?scope=pool` (PoolPollCache); hardware-bound counters machine-local.

## 13. Test plan (Tier 1 / 2 / 3)

Tier 1 — all fixtures enumerated in spec §Testing, notably: three-way admission per class under pinned
pressure; count floors under `targetAlwaysRejects` and `accept-but-ineffective`; distinct-target flood
denied; granularity BOTH ways (incarnation-varying collapses; N distinct stable targets stay distinct);
census widen-only/clamp/independence/stale-floor; sub-debounce crash-loop still ratchets; leading-edge
per-boot flush; corrupt/missing snapshot dispositions; principal always-allow incl. under a THROWING
governor, unpaced; vacuous-override immunity of the last-resort floor; dual-load collision (and the
ATTACH case — later claimant attaches, no re-init, no second flusher); demote alarm silent on clean
re-promote, fires after N; queueMaxTargets shed coalesced; drain fence/predicate rejections; atomic
check-and-mint; token binding/TTL/single-consume.
Tier 2 — real emit path through admit(); route reads live counters lock-free; pool-scope counters answer.
Tier 3 — usage-scan lint (incl. helper-file import of an exempt handle; marker-less admit; duplicate
marker; raw-string admit); token-coverage inventory over every sink (sink-pinned identity; dual-use
principal surfaces accommodated); ratchet generalized over every registered controller.

## 14. Build-PR deliverables checklist

1. `SelfActionGovernor` core + per-controller handles + principal API (§2–§7).
2. Durable snapshot + global anchor (§5).
3. Queue (§5.4). 4. Six notice contracts (§8). 5. Lint extensions + allowlists (§9).
6. Guard-posture + coherence rows + view-seam (§10a–c). 7. Routes + telemetry (§12).
8. Config surface + nested-path PATCH validator + PIN-gated disable (§11).
9. CLAUDE.md template + `migrateClaudeMd` (§11). 10. Full test plan (§13).
11. Registry field additions (`delegatedGiveUp`, parseable model path field).
12. THIS companion reviewed as part of the PR. Retrofit of the ~23 emit sites may land as staged
    follow-up PRs <!-- tracked: CMT-1911 --> (each site: registry model + deriveTargetKey + admit + sink token), but the primitive +
    lints + at least the five registry-modeled controllers land in the first PR.

## 15. Alternatives decision record (codex)

| option | verdict |
|---|---|
| External coordinator (Redis/etcd) | rejected: new external service on a core in-process safety path; ops burden > bespoke-correctness risk given observe-first + review-gated enforce |
| SQLite-WAL admission log / durable work queue | rejected for admission (write amplification on admitSync; durability not needed for level-triggered intents); durable GRANT store (§10.1) may use SQLite per the module's own note |
| Actor-mailbox admission | rejected: serializes per-controller; models neither cross-controller count ceilings nor three-way P17 contract |
| OS/provider quotas (cgroups etc.) | rejected: wrong granularity (process-level, not action-class) and not portable to the fleet's macOS hosts |
| In-process limiter libs (token-bucket/opossum) | partially adopted: the composed internal primitives replicate these shapes behind one contract, keeping registry coupling + relief/sentinel semantics |
| Observe-only forever | rejected: measurement without enforceability re-creates the incident class this closes |
