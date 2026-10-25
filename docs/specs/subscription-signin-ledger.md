---
title: "Subscription Sign-In Ledger"
slug: "subscription-signin-ledger"
author: "Echo"
parent-principle: "Observation Needs Structure"
eli16-overview: "docs/specs/subscription-signin-ledger.eli16.md"
lessons-engaged:
  - "P4 Testing Integrity — the param-route-shadow assertion runs at the E2E tier; the wiring test drives the DEFAULT token resolver on the production path, and the deny-list test asserts against the PRODUCTION root form, because a test against the legacy form passes while production stays open."
  - "P18 Schema is perception — drift-flag transitions are rows; refused foreign rows are quarantined, not dropped, so a refusal is reversible; clock-suspect rows are retained and flagged, never deleted."
  - "P20 Verify the State, Not Its Symbol — the Instrumentation table declares symbol / claimed state / corroboration / unmeasurable result per row kind and statistic; the edge is derived from a re-read of the field named as the symbol, never from the call that intended to write it."
  - "Expected Capacity Enforcement (write path) — refused writes are typed counters, and a refused rising edge is recoverable by level reconciliation, so a busy store cannot permanently lose an outage."
  - "Close the Loop — every claimed outcome is bound to durable evidence."
review-convergence: "2026-08-27T02:45:21.005Z"
review-iterations: 2
review-completed-at: "2026-08-27T02:45:21.005Z"
review-report: "docs/specs/reports/subscription-signin-ledger-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 18
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Justin (topic 33890)"
approved-date: "2026-08-26"
---

# Subscription Sign-In Ledger

Status: CONVERGED AND OPERATOR-APPROVED (80/20 v1 boundary; implementation authorized)
Author: Echo
Date: 2026-08-26
Origin: operator request, topic 33890, 2026-08-26

**Glossary** (terms used before definition, per external review): a **cell** is one
`(accountId, machineId)` pair — the unit that decays; a **pass** is one `pollAll` invocation from
any of its three callers; the **funnel** is the ledger's single write entrypoint; **the raise /
the hold** name the two mechanisms of CMT-169 (below); a **settled fire** is the pass's single
post-resolution observation; **coverage** records whether a cell was measurable in a bucket;
**corroboration** names evidence strength; **provenance** names how a row was recovered/created;
the pool/status field is the **authority** for gating while this ledger is only a signal; a
**demand proxy** measures recent use, not authentication health.

Despite its name, this is a bounded observability state store, NOT an event-sourced audit log;
`events` is diagnostic evidence only and cannot rebuild every mutable projection.

## Problem

Four machines, eight subscription accounts, logins falling out continuously; ~fifteen operator
taps per repair. Nothing records a sign-in, so **rate**, **concentration**, and **cause class**
(expiring vs disappearing) are unanswerable. Cause class is load-bearing: automating re-login
before answering it risks papering over a bug.

Grounding (2026-08-26, Mac Studio): 2 of 8 accounts flagged `owner-relogin-required`, stamped
`2026-08-25T03:29:54Z`, unchanged ~37h; zero log lines anywhere about any sign-in ever.

### What review established about the thing being measured

Both flagged accounts were **not missing a login** — the dual-subscription pair, rendered
`missing-local-login` by an unscoped email lookup (fixed: PR #1980, merged 2026-08-26). A second
family member is unfixed and is **two** mechanisms: the identity oracle classifies an EXPIRED
access token as `unavailable` and the repair plan renders that as `missing-local-login` (the
**raise**); `QuotaPoller` caches an `unavailable` identity reading for 6h, suppressing the
self-clear (the **hold**).

The lesson: `relogin-required` does not mean a login is missing. The instrument records verdicts
the system corroborates, never symbols someone intended.

## Scope

**In:** exchange/status episodes sourced from corroborated `needs-reauth` transitions, with a
typed cause class per incident; separate provisional credential-read windows with typed
observation classes — **including credential absence, which round 4 was structurally blind to**
but never represents as an episode/cause; a coverage denominator; a read route with rollup and
`?scope=pool`; bounded retention whose truncation is visible.

**Out:** the shared guarded Google identity profile; sign-in execution.

## Signal vs Authority

Observability only. Never gates, blocks, triggers, or mutates anything outside its own store.
Every write is record-and-continue: `SQLITE_BUSY` and refused writes increment typed counters,
and a refused RISING edge is recovered by level reconciliation (below) — a busy store loses a
timestamp's precision, never an outage.

## Design

### Programmatic prerequisite gate

Production construction requires static `getContractCapability().version === 1` from
`subscription-pool-authority-foundation.md`. Missing, lower, higher, or partial implementation
constructs the observer/write path disabled. Dynamic `getAvailability()` is independent: the
history route remains active whenever the ledger store is readable and exposes retained history
plus typed `pool-invalid|pool-unavailable`; observation/admission pauses unless authority is
`ready`. Only dynamic `invalid|unavailable` opens/closes the existing authority-gap carrier;
`unconfigured` is legitimate never-enrolled emptiness and pauses observation without a gap.
Missing/incompatible static capability installs a bootstrap diagnostic route returning typed 503
`ledger-foundation-incompatible` and never opens the ledger store. This is a code gate, not
deployment ordering. Update/rollback E2E crosses both axes and proves incompatible code cannot
write/read the store while v1 code with degraded live authority still serves history and gap diagnostics.

### The signal

Three concrete lifecycles anchor the terminology:

1. **Confirmed auth failure:** quota poll → refresh/retry fails → settled observation → status
   re-read shows `needs-reauth` → open one status episode with cause → later status re-read is active
   → close it and compute repair duration.
2. **Credential-read ambiguity:** three same-class read absences spanning 30 minutes → open one
   provisional credential-read window, with no incident event or gating → a later clean token read
   closes only that window.
3. **Unmeasured pass:** resolver/poller aborts before a valid settled observation → write a named
   skipped/unmeasured coverage row → mutate neither status episode nor credential-read window.

In these examples, the **funnel** is the single serialized ledger write entrypoint, a **carrier** is
one durable place that can preserve failure evidence, and **censored** means an interval remains
open or crossed an observation gap so no exact duration may be claimed.

`QuotaPoller.pollAccount` already adjudicates login death properly: on a 401 it attempts a
refresh-token exchange and ONE retry before `markNeedsReauth`, with a reason at every callsite,
and the transient cases (`write-skipped` funnel contention, network nulls) deliberately never
flag. The falling edge is the clean-read restore in `pollAll`. The ledger records those
transitions.

**The disappearance correction, decoupled from authority:** a DELETED credential previously
produced no transition at all — `defaultTokenResolver` receives a typed reason from
`readClaudeOauthAsyncDetailed` and throws the "absent" members away, so the account is silently
skipped. The instrument would have measured REVOCATION and been blind to DISAPPEARANCE, the
operator's actual complaint.

The reader returns three typed reasons (`missing-or-unreadable` | `missing-oauth-block` |
`unparseable`); a fourth condition — the token failing `defaultTokenResolver`'s own
`sk-ant-oat` shape check — is computed in the resolver and today discarded as a bare `null`.
These surface to the ledger as follows, and the SHAPE of the type change is load-bearing:

- **`unparseable-credential-blob` keeps its existing `reauthNeeded` arm and its status write,
  unchanged** — it is the one resolver reason that already flips `needs-reauth` today (not
  exchange-corroborated, but pre-existing behaviour this spec must not silently loosen: dropping
  it would remove a live operator repair prompt and a capacity exclusion, a gating change in the
  loosening direction).
- **The three NEWLY surfaced absence reasons ride a NEW `observationOnly` arm** —
  `TokenResolution = string | null | { reauthNeeded: true; reason: … } | { observationOnly: true;
  reason: 'credential-absent-or-unreadable' | 'credential-missing-oauth-block' |
  'credential-token-shape-invalid' }`. `pollAccount`'s `reauthNeeded` branch is UNCHANGED; a new
  `observationOnly` branch fires the settled observation and returns null **without calling
  `markNeedsReauth`** — the wiring test asserts an absence-class resolution leaves
  `pool.get(id).status === 'active'`. Naming matters here because the obvious edit (widening the
  REAUTH union) would route absence straight into the single writer of `needs-reauth`, i.e.
  implement the exact coupling this paragraph forbids.

Why absence must not gate: `needs-reauth` gates capacity, swap targets, rebalancer participation
and follow-me depth, and renders the operator repair prompt — while the store's read collapses a
3s keychain timeout into the same null as genuine absence, so a transient `securityd` contention
would flip a healthy login's availability, manufacturing the CMT-169 false-flag class this
ledger exists to measure.

What the decoupling buys, stated honestly: it avoids the status flip, the operator prompt, and
the capacity/swap exclusion. It does NOT avoid the ledger observation — but an absence-class
observation opens a credential-read window **only after the SAME absence class is observed on ≥3 consecutive
passes AND ≥30 minutes of wall clock have elapsed since the first of them** — conjunctive,
because pass CADENCE is not guaranteed: `ProactiveSwapMonitor` polls every 180s whenever any
account sits in its watch zone (≥65% utilization — routine, not exceptional), and before this
design the operator route was unthrottled, so three consecutive passes could span ~6 minutes,
which a `securityd`
contention burst comfortably covers. The count-and-time floor is a TUNABLE DEFAULT, not a defensible threshold — no measurement of
real `securityd` outage durations exists yet (this ledger is the instrument that will produce
one), so the stated false-positive budget is honest: a keychain outage longer than 30 minutes
WILL open a false credential-read observation window, and the first measured distribution of
`resolved-read-window` durations is the input for retuning. The two numbers are exposed in the
read surface's metadata and stamped on the opening row (`floorPasses`, `floorMinutes`) so a
later tuning is visible in the data. `startedAt` is backdated to the first qualifying observation
on the window. No incident event or corroboration value is written.
Retuning is operator-governed and passive. The read surface exposes `retuningEligible:true` only
after 30 elapsed days since the first retained credential-read observation AND at least 20 resolved
credential-read windows, plus the duration quantiles, concurrent same-machine absence fraction, and
store-unavailable overlap needed for an ON-DEMAND conversational report. Nothing sends or notifies
automatically; there is no trigger/dedupe/delivery state. A threshold change is a separate
operator-governed change; old rows retain stamped floors, new rows use new values, and rollups stratify
mixed thresholds. Until both evidence floors are met, v1 stays provisional. The API derives
`evidenceMaturity: 'provisional-credential-read'` and returns it with every window/rollup; the
stored window carries the effective `floorPasses`/`floorMinutes` beside the count wherever it is
rendered; UI/API labels
must say “provisional credential-read observation (3 passes / 30 minutes)” rather than “incident.”
The response type keeps it structurally separate from exchange-corroborated auth failures. The
dashboard must render the two in separate sections, and no alert/notice may be derived from the
provisional credential-read series in v1.
At read time (never persisted), at least two DISTINCT `accountId`s on the SAME observing
`machineId`, each with `signalKind:'auth'`, `class:'auth-path-observed'`, and
`authResult:'credential-absence'|'mixed'` in the same fixed 15-minute `observationBucket`, sets
diagnostic-only `sharedStoreFailureSuspected:true` on their observation windows. Absence
observationClass need not match because the suspected shared carrier is below that classification.
Pool rollup exposes named `sharedStoreFailureSuspectedMachines`; it ORs only already-qualified
local flags and never correlates aligned buckets across peers. The flag never alters episode,
accumulator, alert, cause, corroboration, or gating authority. Tests pin positive same-machine/
distinct-account and negative same-account, singleton, cross-machine, demand-proxy, skipped, and
clean-result cases. It makes correlated keychain/securityd failure visible beside the existing
store-unavailable overlap. The
v1 ledger cannot distinguish a long `securityd` outage from true disappearance after the floor;
it reports any overlapping `store-unavailable` interval beside the credential-read window but does not promote
that correlation to cause. The
post-enrollment re-verify's single direct `pollAccount` call structurally cannot supply
the floor. If the operator ever wants absence to GATE, that is a separate decision with its own
confirmation floor — a recorded non-goal, not an oversight. No shared credential module is
modified; `defaultTokenResolver` lives in `QuotaPoller.ts`, already in Changed files.

### Status episodes and credential-read observation windows

The settled-fire outcome enum, closed: `resolved-clean` (tokenResolution was a string) ·
`transition-to-needs-reauth` · `transition-to-active` · `observation-absence` (the
`observationOnly` arm) · `skipped-*` (the coverage-only outcomes). Episode rules:

- A **status episode** opens on the `active → needs-reauth` re-read edge
  (`corroboration: 'exchange-corroborated'` — or `'status-preexisting'` for
  `unparseable-credential-blob`) and closes on the reverse edge.
- A **credential-read observation window** opens per the floor above in its own table and closes
  on the first subsequent `resolved-clean` settled fire for the same attributed id
  (`outcome: 'resolved-read-window'`). A resolvable token is evidence that the read condition
  ended. These windows are never episodes, never enter `medianHoursToResolve`, and are rendered
  only in the provisional credential-read section.
- **The absence ACCUMULATOR, fully specified** (the most likely implementation divergence):
  per cell, `{ class, count, firstAt }`. A pass observing a DIFFERENT absence class RESETS it to
  the new class with count 1; a `skipped-*` or unreadable pass neither counts nor resets; a
  `resolved-clean` pass CLEARS it; an accumulator whose `firstAt` is older than 24h without
  reaching the floor resets (stale evidence must not accrete across unrelated days). The floor
  check is `count ≥ 3 AND now − firstAt ≥ 30 min`.
  This state is durable, not process memory: the `absence_accumulators` table below is updated or
  cleared in the SAME transaction as the settled observation. Restart therefore preserves the
  count/time floor; the 24h stale reset is evaluated transactionally before increment.
- **At most one open status episode and one open credential-read window per cell** (separate
  partial unique indexes), with the mixed-signal priority table closed:

  | open projection | incoming | rule |
  |---|---|---|
  | read window | status rising edge | open the status episode at the rising edge; leave the read window open independently until a clean read; no prefix is attributed to the auth incident |
  | read window | further absence observations | no-op (already open) |
  | read window | `resolved-clean` | close, `outcome: 'resolved-read-window'` |
  | status | absence observations | open/continue the separate read window after its floor; never alter the status episode |
  | status | falling status edge | close, `outcome: 'resolved'` |
  | status | `resolved-clean` without a falling edge | no-op — the status field is the authority for a status episode; a token resolving while status still says needs-reauth is the CMT-171 drift shape, left to the status edge |

An account that becomes disabled, unsupported, removed from the admitted set, or removed from the
pool closes both open projections as `cancelled` in the same reconciliation pass. Temporary
`skipped-identity-unresolved` leaves both projections open but censored and excluded from resolved
duration statistics until a settled authority signal returns.

Normative reducer shape: `reduce({openStatusEpisode,openCredentialReadWindow}, accumulator,
settledOutcome, persistedStatus)` returns `{ statusEpisodeMutation,
credentialReadWindowMutation, accumulatorMutation, eventRows }`. It is the only projection-state
transition function. The tables state compositional rules; executable golden fixtures enumerate
the full four projection-state combinations × every settled-outcome family. Absence
accumulator input/reset rules are exhaustive in the preceding bullet. Coverage coalescing and
retention run after this reducer in the same funnel transaction and cannot veto its edge mutation.
`clockSuspect` is not a reducer input: it flags/excludes resulting evidence but never changes the
transition. `pool-removed`, `disabled`, `unsupported`, and `unadmitted` are the only cancellation
inputs; all cancel both open projections, while unresolved identity holds+censors both. These
rules plus the matrix below are the canonical state machine; later sections add
storage detail but do not redefine transitions.

| settled input | durable event | projection mutations | accumulator | coverage |
|---|---|---|---|---|
| `resolved-clean` | resolved edge only | close read window; status waits for falling edge | clear | auth-path-observed |
| `transition-to-needs-reauth` | `relogin-required` | open status independently | clear | auth-path-observed |
| `transition-to-active` | `relogin-resolved` | close status | clear | auth-path-observed |
| `observation-absence` | no incident event | open credential-read window only at floor | increment/reset | `auth-path-observed`, `authResult:'credential-absence'` |
| `skipped-*` | none | cancel only for disabled/unsupported/unadmitted; else hold censored | hold | matching skipped class |

  Separating the two authorities prevents a transient read blip followed by a real revocation
  from inflating or backdating the exchange-corroborated incident. The unit test drives exactly
  that overlap and asserts independent durations survive a store reopen.

### `causeClass` — the closed set, in full

Derivation rule: the union of `RefreshFailReason` **minus `write-skipped`** (transient by design —
its branch returns before `markNeedsReauth`) **and minus `unsupported-account`** (declared at its
type but produced nowhere: `refreshClaudeToken` takes a config home, not an account), **with
`read-failed` renamed `refresh-read-failed`** to keep it distinct from the resolver's fused class,
**plus** the resolver reasons above, **plus** one poller literal. The mapping test enumerates
every causeClass member from its named callsite, and separately pins that `write-skipped` returns
before `markNeedsReauth` and that `unsupported-account` has no producer — so neither can enter
the union. `markNeedsReauth`'s `reason` parameter is narrowed from `string` to this exported union
(an in-file `QuotaPoller.ts` change), and the `:610` free-text literal becomes the hyphenated
token. An unrecognized string maps to `unrecognized-reason` with a counter — visible, never
dropped.

| `causeClass` | meaning |
|---|---|
| `credential-absent-or-unreadable` | the store's read returned nothing — deleted, or unreadable (honestly fused; splitting requires widening a shared module with 11 consumers, refused — Decision 3) |
| `credential-missing-oauth-block` | blob present, no `claudeAiOauth` |
| `credential-token-shape-invalid` | blob present with a `claudeAiOauth` object, but NO `accessToken` or one failing the `sk-ant-oat` prefix check (honestly fused — the resolver's single ternary cannot separate them) |
| `unparseable-credential-blob` | blob present, not parseable |
| `refresh-read-failed` | blob readable at resolve time, gone/unparseable at refresh time — mid-pass deletion or store contention; kept separate from `credential-absent-or-unreadable` because the two carry different evidence |
| `no-refresh-token` | readable blob, valid-shaped access token, refresh token gone — wipe/partial-deletion signal |
| `exchange-failed` | the OAuth endpoint rejected the refresh — revocation |
| `malformed-response` / `write-failed` | exchange anomalies, kept distinct |
| `still-authfailed-after-refresh` | fresh token still rejected |
| `unrecognized-reason` | mapping fallback, counted |

### Edges: derived from the field, attributed to the row that changed

Two subtleties, both from reviewers reading `pollAll` harder than I did:

- **Attribution.** Under identity drift, `pollAll`'s restore predicate reads the ENUMERATED
  record while the write lands on the ATTRIBUTED id — a live QuotaPoller bug this review
  surfaced, tracked separately — so an edge could open on one account and
  close on another, fabricating fast resolutions and stranding open episodes. Both edges are
  therefore keyed on the ATTRIBUTED id, and each edge is derived from a **re-read of
  `pool.get(attributedId).status`** at the settled fire — never from the `markNeedsReauth` call,
  whose `pool.update` sits in a swallowing catch and can fail while the call proceeds. A
  repeated failing pass against an already-open episode is a no-op; the open-episode row IS the
  durable prior status across restarts, so a restart cannot double-open. Unit test: a drifted
  pass must not open on one id and close on another.
- **Level reconciliation.** Edge rows are record-and-continue, so a refused
  `transition-to-needs-reauth` write would otherwise lose the episode forever while every later
  pass observes the level. An `observed-needs-reauth` with no open episode opens one with
  `provenance: 'inferred-from-level'` (causeClass `unrecognized-reason`, stated); episode-open is
  idempotent on `(cell, open-edge)` so the three uncoordinated `pollAll` callers cannot
  double-fire.

### The observation callback — two fires per account per pass

Round 4's "once, before every early return" could not produce half its own payload: transitions
happen later in the pass, restores happen in `pollAll` after `pollAccount` returns, and the
skipped-* cases `continue` before `pollAccount` is called. The contract is now explicit:

1. **Enumerated fire** — in `pollAll`, before the `supported`/`disabled` continues, carrying the
   cell's PRIOR status. Structurally, `pollAll` builds the admitted census solely from indexed
   incumbent revalidation plus `scanAccountsBounded(4096)`—it never calls materializing
   `pool.list()`—then registers the ENTIRE ADMITTED census (never overflow cells) with the
   observer before processing the first admitted cell; per-cell enumerate then adds
   prior-status payload but not membership. A throw at cell N therefore leaves every unvisited
   admitted suffix cell registered and finishable as aborted. Overflow cells never allocate
   observer state or coverage rows; they remain `unmeasured-capacity-unsupported`.
2. **Settled fire — exactly ONCE per (cell, pass), enforced by a `LedgerPassObserver` object that
   owns the per-pass guard token and exposes only `enumerate(cell)` / `settle(cell, outcome)` /
   `finishSkipped(cell, outcome)`. Callers cannot invoke the raw recorder.** For a
   snapshot-returning account it fires only at `pollAll`'s post-restore-patch
   point; for every other `pollAccount` return path it fires inside `pollAccount`; for the direct
   caller (`reverifyCompletedEnrollment` in routes.ts calls the public `pollAccountDirect` wrapper)
   this rule OVERRIDES the snapshot rule: that wrapper owns
   `LedgerPassObserver.forDirectCell(cell)`, which
   registers exactly one expected target without emitting an enumerated fire, so the
   in-`pollAccount` fire is suppressed — no enumerated fire; the open-episode row is the SOLE
   prior-status authority on every path, so that costs nothing.
   **The logical final observation is buffered at the last fire of the pass** — settled where one
   occurs; `finishSkipped(cell,outcome)` marks a registered `skipped-*` cell complete when it
   continues before `pollAccount`. Physical reducer/coverage commit occurs only at observer
   `finish()`. An unreadable/aborted cycle
   never counts as measured (Decision 15 holds).

Payload is DERIVED values only — outcome enum, `causeClass`, `driftFlag: boolean` (the boolean,
never the object, which contains an email). No blob, no oauth object, no token string crosses the
boundary; sentinel tests cover the success AND failure paths, plus the `@` assertion.

`identityDrift` transitions are recorded as `drift-flag-transition` rows (`identityDrifted` +
`repairState`, two named fields), so the CMT-169 false-flag rate is a single-table query.

`settle()` buffers the derived outcome only; it performs NO reducer or storage mutation.
`LedgerPassObserver.finish()` validates cardinality for every enumerated cell, then applies the
reducer and coverage write once in one funnel transaction. Thus a later duplicate cannot arrive
after an edge has already committed. In direct mode, `finish()` validates the one constructor-owned
target rather than accepting arbitrary settle-only cells; normal poll mode still rejects any cell
not registered through `enumerate()`. `pollAccount`'s raw implementation is private and requires a
`LedgerPassObserver`; the sole public `pollAccountDirect(account)` wrapper constructs, settles,
finishes, and returns the snapshot. Routes never receives an observer. Both `pollAll` and
`pollAccountDirect` own their observer in `try/finally`; idempotent `finish(): void` runs exactly once
from `finally`. An expected cell left unsettled by throw, cancellation, timeout, or early return
becomes `unmeasured-observer-aborted` before validation. Finish/storage failure reaches the
independent refusal sidecar/latch best-effort, but `finish()` catches every reducer/storage/carrier
failure and is externally non-throwing. It preserves byte-equivalent wrapped return values and the
original thrown error/cancellation; a `finally` failure can never replace authority behavior. A
static callsite test refuses raw or observer access outside `QuotaPoller`.
At runtime `LedgerPassObserver.finish()` increments closed counters
`observerMissingSettle` / `observerDoubleSettle` when a cell has zero or more than one settled
fire; either condition writes unmeasured coverage and never runs the reducer. Tests add a new early
return and deliberately buffer an episode-opening first settle followed by a duplicate to prove no
edge commits and the invariant is enforced, not merely linted.

### Codex accounts (the conformance gate's flag, judged material)

Two of the operator's eight accounts are codex-cli. Their poll path reads a rollout FILE and no
credential, and `needs-reauth` is written in exactly one place that codex can never reach — so a
constant `skipped` value would be a permanent silent zero on 25% of the fleet. The coverage value
for codex cells is therefore split using data the poller already holds at that branch:
`codex-rollout-fresh` (`capturedAt` ≤ 6h old — one number, matching the poller's existing 6h
`identityCacheTtlMs` staleness convention) / `codex-rollout-stale` (> 6h, hours attached) /
`codex-rollout-undated` (`capturedAt === null` — the reader types it nullable; excluded from the
measured denominator) / `codex-no-rollout`. Honest scope: this is a DEMAND proxy — a revoked codex
login that nothing exercises stays invisible — and every codex coverage row carries
`signalKind: 'demand-proxy'` (claude cells carry `'auth'`), so proxy rows are excluded from
auth-health aggregates by type, never by a consumer remembering to. A real codex auth signal exists (`auth.json` shape
check) but is a credential-blob probe, which this design deleted; whether to add it is the second
Open question.

## Instrumentation table (P20)

| Row | Symbol read | State claimed | Corroboration | When unmeasurable |
|---|---|---|---|---|
| `relogin-required` | re-read `pool.get(attributedId).status` edge | this login cannot authenticate | a live 401 + failed refresh + failed retry this pass (or, for `unparseable-credential-blob` only, the pre-existing status write) | poller dead / cell skipped → no row; coverage says why |
| credential-read observation window | ≥3 consecutive `observationOnly` absence observations spanning ≥30 min | the credential store yielded no usable token across the floor window | NONE — no incident event/corroboration is written | resolver threw / floor (passes AND minutes) not met → no row |
| `relogin-resolved` | same field, reverse edge, same attributed id | this login authenticates | a clean authenticated usage read | same |
| level-reconciled open | `observed-needs-reauth` level with no open episode | an outage whose opening edge was lost | the level itself, marked `inferred-from-level` | — |
| `drift-flag-transition` | `identityDrifted` edge | the identity subsystem changed its mind | none — this row MEASURES that subsystem | flag unreadable → no row |
| `login-expired` | writer-path expiry callback in `PendingLoginStore` | this enrollment attempt expired unused | none — writer-path only, the count is a LOWER BOUND | expiry outside a writer path → invisible, never inferred |
| coverage row | settled fire per cell per pass | the cell was enumerated with the stated outcome | synchronous with the pass | store down → `unmeasured-store-unavailable` via the watermark |
| episodes / rate | closed-episode count | re-sign-in demand per cell | each episode exchange-corroborated or level-marked | below floor → `null` |
| `medianHoursToResolve` | closed durations, attributed-id-consistent | operator time-to-repair | resolved edges only | <2 resolved → `null`; gap-spanning → bounds |
| `meanHoursBetweenEpisodes` | inter-episode intervals | decay rate | ≥3 episodes AND ≥70% `auth-path-observed` coverage of the window | else `null` |
| `writesRefused` | funnel counter | rows the ledger failed to keep | incremented at the catch; edges recovered by level reconciliation | store down → watermark |

## Coverage and time

- At most one coverage row per cell per fixed 15-minute ledger bucket, regardless of configurable
  poll cadence or how many proactive/manual passes occur inside it. The `LedgerPassObserver`
  computes `observationBucket = floor(ts / 900_000)` and SQLite enforces
  `UNIQUE(accountId,machineId,observationBucket,signalKind)`, so overlapping timer/proactive/manual
  passes coalesce instead of amplifying writes. `POST /subscription-pool/poll` additionally uses
  a per-process one-in-flight/60s result cache; a duplicate request returns the cached poll result
  and does not start another provider poll. This bounds the ledger producer and upstream API
  work. `observedHours` derives from **timestamps**, sum
  of capped inter-observation deltas, clamped to the elapsed window, clamp reported). Volume
  basis, honestly: three callers — the 15-min timer, `ProactiveSwapMonitor`, operator `POST /poll`
  — but bucket uniqueness bounds persistence to 96 rows/cell/day: 768/day for the operator's
  current eight cells and 6,144/day at the supported 64-cell ceiling.
  Within one bucket the UPSERT uses an evidence-improving lattice, never first-writer wins:
  `auth-path-observed` outranks every auth `skipped-*`; within auth-path-observed rows,
  `authResult` uses a lossless lattice: same+same stays that value, clean+absence in either order
  becomes `mixed`, and `mixed` is absorbing against either raw input. EVERY auth-result pair uses
  the same commutative field join: evidence `ts = max(constituent evidence ts)`; `lastObservedAt =
  max(all arrival timestamps)`; `representsMinutes = max(constituents)`; and
  `pollIntervalMsInForce` comes from the max-evidence-ts constituent (equal-ts tie → larger numeric
  interval). Reverse arrival for same-result, mixed-result, or different-result pairs therefore
  produces byte-identical semantic fields and identical
  metrics. For demand proxy,
  `codex-rollout-fresh > stale > undated > no-rollout`. Expected
  coalescence never increments `writesRefused`, and an edge/event
  mutation still commits when its coverage row conflicts. Tests drive both arrival orders and an
  edge plus duplicate coverage in one transaction.
- Persisted coverage values: `auth-path-observed` · `skipped-unsupported-framework` · `skipped-disabled` ·
  `skipped-identity-unresolved` · `skipped-identity-unenrolled` (the oracle resolved an identity
  the pool does not hold: `pool.get(attributedId)` is undefined, so the settled fire keys the
  coverage row on the ENUMERATED cell, emits no edge, and leaves any open episode open — a cell
  is only ever created for a list-visible id returned by the bounded canonical scan, so an oracle-supplied string can never
  mint one) · `codex-rollout-fresh` · `codex-rollout-stale` · `codex-rollout-undated` (`capturedAt === null`, excluded from the measured denominator) · `codex-no-rollout` ·
  `unmeasured-observer-missing-settle` · `unmeasured-observer-double-settle` ·
  `unmeasured-observer-aborted`. The observer
  invariant classes are persisted for diagnosis and excluded from every denominator.
- Synthesized read states (never persisted in `coverage.class`):
  `unmeasured-poller-not-started` (from the ledger's own construction-time check —
  `quotaPoller.start()` is gated on a non-empty pool at boot) · `unmeasured-store-unavailable`
  (from the watermark) · `unmeasured-capacity-unsupported` · `not-yet-observed`. The four
  `unmeasured-*`/`not-yet-observed` values are synthesized read states, never persisted coverage
  classes. In pool scope only, the peer failure set
  defined ONCE here and referenced by the read surface: `no-known-url` · `offline` ·
  `route-missing` (transport) · `peer-ledger-disabled` · `peer-pool-unconfigured` ·
  `peer-pool-invalid` · `peer-pool-unavailable` ·
  `peer-store-unavailable` · `peer-capacity-unsupported` (peer-reported).
- Coverage gaps join episode arithmetic: gap-spanning episodes report
  `resolveHoursLowerBound`/`UpperBound`, excluded from the median, counted in
  `resolveLatencyUnbounded`. `resolveLatencyFloorMinutes` reported; the floor is one-sided.
- Clock skew validated both directions; clock-suspect rows are RETAINED and flagged, never
  dropped; `excludedForClockSkew` reported split by direction. Status edges still mutate episode
  state in server receive order because the persisted pool status is authoritative, but their
  durations are excluded. A clock-suspect absence observation does not increment/reset the
  accumulator or satisfy its wall-time floor; it writes coverage/diagnostics only. A
  clock-suspect close cannot yield a duration statistic.

## Storage: SQLite

`better-sqlite3` at `state/subscription-login-ledger/ledger.db`, via
`NativeModuleHealer.openWithHealSync` (unhealable → `enabled: false`, never a boot failure);
`chmodSync(db, 0o600)` BEFORE the WAL pragma (sidecars inherit; unit-tested under umask 022);
pragmas `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`; the second accessor is
second-instar-on-host. **Locking model, stated exactly:** the SERVER process owns all writes; every mutation — edges,
coverage, retention, counters — goes through one funnel on the server's single better-sqlite3
handle. better-sqlite3 is synchronous, so in-process calls serialize on the JS thread by
construction — the three `pollAll` callers cannot interleave inside a funnel call. Writer
authority is inherited from the server's existing `SingleInstanceLock`: only a process with
`acquired:true && overridden:false` is constructed with ledger write capability. That same
capability object gates BOTH SQLite and the refusal sidecar; there is no independently writable
sidecar helper and no callsite can obtain only one writer. The
`INSTAR_ALLOW_SECOND_INSTANCE=1` override is always ledger-readonly, even when no primary is
currently discoverable; it never manufactures writer authority. Any second accessor opens with
better-sqlite3's `readonly: true`, enforced by mode rather than a heartbeat lease. There is no
time-based takeover and therefore no 10m/15m split-brain window; takeover happens only after the
existing single-instance authority admits the new server. A real child-process wiring test starts
a primary OS process, a normal contender, and an override contender. Each loser exercises the
production DB write entrypoint and independently forces the production refusal-sidecar entrypoint;
readback and byte snapshots prove neither carrier changed. It then tests clean release and primary
crash takeover, proving only the newly lock-admitted process can write/read back both carriers.
Fake-clock coverage also holds the primary past 15 minutes to rule out time-based authority. An
unexpected SQLite collision is absorbed by `busy_timeout=5000` + the
`writesRefused` counter. Transaction boundary = one funnel call; an edge and its coverage row commit in one
transaction, so retention (also funnel-serialized) cannot interleave an episode's open and close. Filters reach the DB only as bound parameters; `machineId` values are
normalized at the single write funnel (lowercase, trailing `.local` stripped) and the filter
charset is `^[a-z0-9._-]{1,128}$` — injection safety is carried by `prepare()`, not the charset.

**Alternatives rejected** (external review): an append-only event log re-creates round 2's
rotation/truncation problems; a shared replicated event stream replicates an observation store
for nothing the `?scope=pool` read does not provide and adds a consistency surface; SQLite
local-first matches the repo's ~15 healer-wrapped stores.

A bounded append-only SQLite events table plus projected state was considered separately and can
enforce the same invariant when paired with a unique projected-state table. The chosen mutable
`episodes` table is a pragmatic local simplification: this feature already needs transactional
projection for accumulator/coverage state, so replay adds machinery without improving the
operator's evidence. SQLite's partial unique index directly enforces one open episode per cell;
raw lifecycle evidence remains append-only in `events`.
The event rows are audit evidence, NOT a complete replay log: accumulator counts, coalesced
coverage, admitted-cell membership, and episode close/provenance state exist authoritatively only
in their mutable tables. Rebuilding `episodes` from events is unsupported. That loss is acceptable
because this is bounded observability rather than an action authority; retention already makes
historical replay intentionally incomplete, while mutable tables preserve the published
one-open-episode and censoring invariants.
Metrics/OpenTelemetry alone were also rejected: counters and exemplars cannot carry the durable
one-open-episode invariant, restart recovery, per-cell censoring bounds, or visible retention
floor without rebuilding a state store beside them. The ledger can export metrics later, but
metrics are not its authority.
An external workflow/state-machine engine was also rejected: the reducer is synchronous, pure,
closed-enum, and transaction-local, so another runtime would add recovery/serialization authority
without reducing states. Implementation instead uses the canonical matrix as table-driven reducer
tests, with one case for every matrix row and open-episode kind.
A local retry queue/outbox is unnecessary: writes are observational, every failure is counted,
and level reconciliation recovers missed status edges. Retrying old observations later would
fabricate precision and ordering; the synchronous bounded funnel preserves the honest failure.
A smaller “episodes + coverage only” slice was rejected because it cannot preserve event-key
idempotency after retention, distinguish refusal from a healthy zero, or bound/reconcile the
unified census. The pool authority and bounded-enumeration work is intentionally NOT part of this
feature. It is the separately converged P0 prerequisite in
`subscription-pool-authority-foundation.md`; the ledger cannot activate until that prerequisite is
live. This spec consumes only its typed availability and `scanAccountsBounded(4096)` contract.
A separate credential-presence/shape probe was rejected even as a non-gating signal because the
existing reader fuses missing with keychain timeout and shape with absence; a second row would
look independent while repeating the same ambiguity. The typed resolver observation already
carries everything that probe can honestly say. A future provider-native authenticated check is
additive when one exists.

**`machineId` (Decision 8):** prefer the coordinator's persisted, signed machine id, injected at
construction. It is an independent machine-bound carrier rather than the watermark value being
judged. On a non-mesh/single-machine install, mint a persisted random id into the watermark and
honestly adopt it on restart; that fallback does NOT claim it can detect a manually restored
foreign watermark. `os.hostname()` (normalized) is only the recorded FALLBACK for a row written
before either stable id exists — every row carries
`machineIdSource: 'stable' | 'hostname'`, so a fallback cell is visibly a fallback. Hostname flap
is a documented in-tree incident (`SingleInstanceLock`'s `mac.lan ↔` auto-heal), not a
hypothetical, and hostname collisions between machines MERGE cells silently — a generated id has
neither failure. The mesh id is attached at pool-merge time from the responding peer, never
stored in rows.

**Retention (Decision 14):** separate numeric bounds: 180 days AND max 50k event rows; 180 days
AND max 320k coverage rows; 180 days AND max 20k closed credential-read windows; at most one open
credential-read window and one accumulator row per admitted cell; max 5k quarantine rows.
The coverage cap is derived, not decorative: 64 cells × (96/day × 7 full-resolution days +
24/day × 173 hourly-decimated days) = 308,736, leaving 11,264 rows of headroom. Coverage is
hourly-decimated after day 7. Event eviction under age OR cap pressure first removes oldest
standalone enrollment/drift/lifecycle rows (while retaining the newest lifecycle row of each kind
per active attempt), then removes oldest CLOSED episodes with all linked events as indivisible
units. An open episode retains only its opening event and latest drift event, so open state cannot
make the global cap unbounded. Every event/coverage/window/quarantine insert performs a
same-transaction cap check. Opening does not consume the 20k CLOSED-window budget; at most 64 open
rows are bounded by admission. Closing a window first evicts the oldest CLOSED victim in the same
transaction when the cap is full, then closes the current row. If no closed victim exists, the cap
cannot be full; this invariant is asserted. The hourly sweep is maintenance, not the only enforcement. If every remaining event
is protected and no victim exists, the incoming observational row is refused,
`writesRefused` advances with `lastWriteErrorClass:'capacity'`, and the authority path continues
unchanged; a no-victim test pins the strict 50k bound. Coverage's retained row is
stamped at decimation time with `representsMinutes`, the span it stands for — without this the
2×-interval delta cap would integrate a fully-measured decimated region to ~50% and permanently
null every ≥70%-gated statistic past 7 days; a unit test asserts decimating a fully-measured
60-day window does not move its coverage fraction). **Trigger, stated (Self-heal posture forbids a timer):** a retention pass runs inside the
funnel at `ledger-started` and thereafter at most once per hour, gated on a `lastRetentionAt`
timestamp in the watermark, and BOUNDED independently per table (max 5k event deletes + 5k
coverage deletes + 5k closed-window deletes + 5k quarantine deletes + 5k expired tombstone deletes per pass). Refusal-sidecar
pruning is an atomic bounded rewrite, described below, rather than a SQLite delete. The per-insert cap check preserves each hard
bound even during a burst. The 64-cell ceiling is checked on every observation, not only at boot.
The `admitted_cells` table persists the admitted set with `(accountId,machineId)` primary key and
`admittedAt`; existing members never lose admission due to list reorder/restart. Vacancies are
computed ONLY from ids returned by the pool's bounded canonical account scan, never oracle-attributed ids. One exported
`isQuotaPollSupportedAccount(account)` predicate is used by BOTH QuotaPoller and admission;
eligibility is that predicate AND real `account.status !== 'disabled'`. `active`, `warming`,
`rate-limited`, and `needs-reauth` all remain eligible for observation, as do temporarily
identity-unresolved cells. Disabled/unsupported incumbents are removed and both projections cancelled;
re-enabled/newly-supported cells rejoin the wait set. Vacancies are filled by the
lexicographically-smallest eligible waiting stable cell id in the same reconciliation transaction.
The prerequisite supplies a non-materializing
`scanAccountsBounded(limit): { accounts, truncated, examined }`, typed pool availability, constant-time
incumbent lookup, and canonical visibility/support semantics. Before candidate scanning, every
persisted incumbent (≤64) is revalidated through that contract, so absence, disablement, or
support changes are distinguishable from list reorder beyond the scan prefix. Reconciliation runs
every poll pass, not only on config change. It then calls `scanAccountsBounded(4096)` and uses a fixed
64-entry max-heap: O(min(N,4096))
CPU, O(64) additional memory, no full overflow copy/sort. Beyond that hard ceiling it sets
`poolCensusTruncated:true`, reports `overflowCountAtLeast`, admits nothing unseen, and nulls
fleet-completeness aggregates; overflow cells synthesize `unmeasured-capacity-unsupported`.
Tests use real `SubscriptionAccount` objects and cover every status in incumbent/waiting positions,
production disable/re-enable mutation, reorder, restart, remove/refill, provider/framework support
changes, identity loss, attributed-id change, and incumbents/candidates beyond the 4,096 boundary.
**Incident `retentionFloorAt` =
`max(oldest surviving coverage row, oldest surviving event)`** — the more-truncated side — and
incident `windowTruncatedByRetention` derives from that value. Independent
`credentialReadWindowRetentionFloorAt` derives only from the credential-window table and controls
only that top-level section. Neither floor invalidates the other's statistics; shared refusal and
pool-authority gaps may invalidate both.
Each retained table has an explicit creation/last-reset floor persisted in the watermark even when its table
is empty; “oldest surviving” means that floor for an empty table. Fresh install, one-empty, and
all-empty behavior is therefore deterministic.
Every atomic retention commit updates its affected per-table floor and derives incident
`retentionFloorAt = max(eventRetentionFloorAt, coverageRetentionFloorAt)` plus the separate
credential-window floor in the same watermark
overwrite.

**The watermark file:** `state/subscription-login-ledger/watermark.json`,
0600, atomic overwrite (all fields in ONE write), schema
`{ schemaVersion, machineId, machineIdMinted, machineIdOrigin:
'coordinator'|'minted'|'adopted'|'reminted', supersededHostname: string|null, lastWriteAt,
lastRetentionAt, eventRetentionFloorAt, coverageRetentionFloorAt,
credentialReadWindowRetentionFloorAt, retentionFloorAt,
refusalRetentionFloorAt, guaranteedPollIntervalMs, writesRefused, lastWriteErrorClass,
lastLifecycle: { state: 'started'|'stopped', at } }`. Missing fields migrate idempotently to
safe defaults in one atomic rewrite. Writer ownership is deliberately absent:
`SingleInstanceLock`, not this observability file, owns that authority.
`machine-id-adopted` / `machine-id-reminted` are BOTH also event rows in the db (one carrier),
with `machineIdOrigin` the watermark's own record of the same fact.
`unmeasured-store-unavailable` renders when `lastLifecycle.state === 'started'` and `lastWriteAt`
is older than `clamp(2 × guaranteedPollIntervalMs, 30m, 24h)`. The configured guaranteed cadence
updates atomically on change; migration defaults to 15m. This liveness threshold is independent
of the fixed 15m coverage bucket. The database, WAL/SHM, and watermark all live inside
one dedicated `subscription-login-ledger/` directory. When coordinator identity exists and the
directory identity mismatches, the store closes/checkpoints when possible, writes+fsyncs a
quarantine intent in the parent, then atomically renames the WHOLE directory to
`subscription-login-ledger.foreign-<timestamp>/`, fsyncs parent metadata, creates a fresh local
directory, and clears the intent. Startup completes or rolls back any intent before SQLite opens.
Live and foreign directories are `0700`; DB/WAL/SHM/watermark/intent files are `0600`. Before a
new quarantine, the one existing foreign-directory slot is reclaimed through `SafeFsExecutor`
(guarded + audited) and free space is checked. Cleanup failure returns `store-unavailable` BEFORE
renaming the newly detected store, so repeated mismatches cannot accumulate directories. The
fresh DB records one scrubbed `foreign-store` quarantine row with counts only. Without coordinator identity,
the existing minted id is adopted and the foreign-origin state is explicitly unknowable.
**Mint reconciles against the store ONLY when no coordinator identity exists:** if the events table holds
rows under exactly one distinct machineId, the mint ADOPTS it and writes a `machine-id-adopted`
lifecycle row — a lost watermark must not orphan every prior row under a fresh id; more than one
distinct id → mint fresh with a `machine-id-reminted` marker the read surface reports beside
`retentionFloorAt`. `machineId` and `machineIdMinted` are written in one atomic overwrite. With
coordinator identity, directory identity is validated BEFORE normal queries. No row-by-row import
occurs, so a max-sized foreign store cannot stall startup or consume local caps. Rename/recovery
failure yields typed `store-unavailable`; chunked cleanup does not exist. Tests interrupt after
intent fsync, directory rename, fresh-directory creation, and intent clear, then verify restart
recovers deterministically without opening mixed sidecars.
Rows written under the hostname fallback are MERGED into the stable cell at read time when the stable
id's watermark records the hostname it superseded (`supersededHostname`), so first-boot rows keep
continuity rather than fabricating churn. It appears in BOTH deny lists, the posture table, and the rollback set.

**Schema, compact but normative:**

```
events   (id INTEGER PK, ts TEXT, kind TEXT, accountId TEXT, machineId TEXT,
          machineIdSource TEXT, attemptId TEXT, eventKey TEXT, episodeId INTEGER, causeClass TEXT,
          corroboration TEXT, driftFlag INTEGER, repairState TEXT,
          clockSuspect INTEGER)
          INDEX (accountId, machineId, ts); INDEX (episodeId);
          UNIQUE(eventKey) WHERE eventKey IS NOT NULL
episodes (id INTEGER PK, accountId TEXT, machineId TEXT, openedAt TEXT, closedAt TEXT,
          causeClass TEXT, corroboration TEXT, outcome TEXT, provenance TEXT)
          UNIQUE (accountId, machineId) WHERE closedAt IS NULL   -- at most one open per cell;
                                                                 -- the idempotency key for opens
credential_read_windows (id INTEGER PK, accountId TEXT, machineId TEXT,
          openedAt TEXT, closedAt TEXT, observationClass TEXT, outcome TEXT,
          floorPasses INTEGER, floorMinutes INTEGER)
          UNIQUE (accountId, machineId) WHERE closedAt IS NULL
coverage (id INTEGER PK, ts TEXT, lastObservedAt TEXT, accountId TEXT, machineId TEXT, class TEXT,
          signalKind TEXT, authResult TEXT, observationBucket INTEGER, pollIntervalMsInForce INTEGER,
          representsMinutes INTEGER,
          UNIQUE(accountId,machineId,observationBucket,signalKind))
          INDEX (accountId, machineId, ts)
absence_accumulators (accountId TEXT, machineId TEXT, class TEXT, count INTEGER,
          firstAt TEXT, lastAt TEXT, PRIMARY KEY(accountId,machineId))
admitted_cells (accountId TEXT, machineId TEXT, admittedAt TEXT,
          PRIMARY KEY(accountId,machineId))
quarantine (id INTEGER PK, receivedAt TEXT, reason TEXT, sourceMachineId TEXT,
          rowKind TEXT, scrubbedPayload TEXT)
event_key_tombstones (eventKey TEXT PRIMARY KEY, firstSeenAt TEXT, expiresAt TEXT)
write_refusals (hourBucket INTEGER, errorClass TEXT, count INTEGER,
          PRIMARY KEY(hourBucket,errorClass))
```

`episodes` contains exchange/status incidents only. Its partial unique index is the exactly-once
open guard for auth incidents. `credential_read_windows` is a separate observational projection
with its own guard; no query unions it into incident counts or time-to-repair statistics.

`quarantine` is a table in the same 0600 database, never a sidecar file. `scrubbedPayload` is
rebuilt from the same closed non-secret allowlist accepted by the event funnel; raw rejected
bytes are never persisted. It is capped at 5k rows / 180d and exposed only as counts and closed
reason classes.

`write_refusals` carries only refusals that SQLite can commit: closed-enum validation/policy and
capacity refusals. It is outside the capped event path and retains 180 days of hourly typed counts
(hard cap = 4,320 buckets × the closed transactional-refusal enum). Before every UPSERT, the same
transaction deletes enough expired oldest buckets to admit the new bucket without crossing that
cap; the hourly sweep independently removes at most 5k expired refusal rows. Thus first write after
a long offline interval is bounded immediately, not after catch-up. Capacity refusal cannot refuse
this carrier because victim selection reserves the carrier transaction before rejecting the
observational row.

SQLite `busy`/BEGIN/INSERT/COMMIT failure, I/O failure, and store-unavailable are deliberately NOT
claimed to be recordable in the transaction they invalidate. They use an independent 0600 atomic
sidecar, `state/subscription-login-ledger-refusals.json`, schema
`{ schemaVersion, buckets: [{hourBucket,errorClass,count}], incompleteHourBuckets: [INTEGER],
poolAuthorityGapHours: [INTEGER], openPoolAuthorityGapSince: string|null, retentionFloorAt }`,
with closed error classes and the same 4,320-hour/180-day bound. Its
single-process writer prunes expired buckets before every atomic rewrite; at most one row exists per
hour/error class. The sidecar lives outside the quarantinable ledger directory so a DB-directory
rename or SQLite failure does not erase its carrier, but it remains under the ledger backup deny
prefix. A store-layer catch updates this sidecar best-effort before returning. If that independent
write also fails, the process latches `evidenceIncompleteSince` in memory and every summary whose
window intersects the open latch is null. On the next successful sidecar write, every UTC hour
intersecting the interval from the original latch time through recovery is inserted into the
deduplicated `incompleteHourBuckets` set before the live latch may clear. This conservatively
preserves the closed historical blind interval without nulling later windows forever; the set is
pruned and hard-capped to the same 4,320-hour horizon before each rewrite. Clean shutdown is fail-closed: while this latch is
pending it synchronously retries the sidecar write and MUST NOT write watermark
`lastLifecycle:'stopped'` unless that write succeeds. The already-durable `started` record therefore
remains the restart proof if both carriers are unavailable; a clean-stop label can never erase
RAM-only uncertainty. Startup after any lifecycle lacking that clean proof marks
the interval from watermark `lastWriteAt` through restart as evidence-incomplete; if the ledger and
watermark were both lost, the new store's retention floor is its creation time, so earlier windows
are truncated rather than presented as observed. This is the honest limit: no design promises a
durable record while every available persistence carrier is failing.

Read-time refusal intersection is the union of transactional `write_refusals`, sidecar refusal
buckets, closed `incompleteHourBuckets`, and the live `evidenceIncompleteSince` latch. Both carriers persist an explicit creation/last-reset floor even
when they contain zero buckets (SQLite's floor is in the watermark; the sidecar's is its own
`retentionFloorAt`). `refusalRetentionFloorAt` is always the later of those explicit floors,
including fresh, one-empty, and both-empty states. A requested window predating it sets
`refusalWindowTruncated: true` and nulls
rate/cause aggregates. Later error classes never overwrite earlier buckets.

Pool `invalid|unavailable` onset uses this independent sidecar as its restart-safe authority: the
first observed timestamp is persisted in `openPoolAuthorityGapSince` and never advanced by later
failed restarts. On repair+restart, every intersected UTC hour closes into deduplicated
`poolAuthorityGapHours` before the open field clears. Both are pruned/capped with the same 180-day
horizon and consumed identically by local and peer summaries. If this sidecar write also fails, the
existing evidence-incomplete latch makes the interval no more trusted, never less.

Enrollment `eventKey` is kind-specific: genuinely once-per-attempt events use
`<kind>:<attemptId>`. `code-submitted` deliberately has `eventKey = null`: it records only a
processed submit attempt that reaches the route's named `validated | held | submitted` outcome
path. Validation errors, transport errors, and timeouts before that outcome emit no row. A retry
that reaches the path again is another processed request attempt. The row is excluded from
“human taps” or unique-intent aggregates; v1 does not claim to measure that intent. Expected uniqueness conflicts are idempotent no-ops and never
roll back the login transition. When an event-keyed row is evicted, its key moves to
`event_key_tombstones` in the same transaction for the 180-day published-history horizon;
tombstones are capped at 50k (no greater than event capacity), checked before insertion, and
prevent delayed retries/repeated expiry discovery from re-entering the visible series after row
eviction. Capacity is reserved at keyed-event admission: the union of live non-null `eventKey`
values plus unexpired tombstones may never exceed 50k. At saturation a new keyed observational
event is refused with the typed `capacity` counter while the old row/tombstone remains; eviction
can therefore always move its already-reserved key into the tombstone table atomically. Reopen,
retention, delayed retry, fully-saturated, and crash-between-row/tombstone tests pin this.

Capacity invariants, enforced in the write transaction: `(live keyed eventKeys ∪ unexpired
tombstone keys).size ≤ 50_000`; evicting a keyed event implies inserting its already-reserved
tombstone in the same transaction or performing no eviction; an unreserved keyed insert at the
ceiling is refused before any row mutation.

Closed domains for the persisted columns (Decision 5 applies to every on-disk value):
- `events.kind`: `relogin-required` · `relogin-resolved` · `drift-flag-transition` ·
  `login-issued` · `login-reissued` · `code-submitted` (producer: the routes.ts submit-code
  outcome path — validated/held/submitted — NOT `PendingLoginStore`; stated because that fire,
  like the direct-caller settled fire, lives in routes.ts) · `login-completed` · `login-expired`
  · `login-cancelled` · `ledger-started` · `ledger-stopped` · `machine-id-adopted` ·
  `machine-id-reminted`. `login-failed` and `login-denied` are DELETED from the domain — the
  submit-code path's outcomes are validated/held/submitted and no denied/failed transition
  exists, so they would be permanent silent zeros (the same class the codex coverage redesign
  exists to prevent). The Testing section pins every declared kind producible from its named
  callsite, exactly as it does for `causeClass`.
- `episodes.outcome`: `resolved` · `cancelled` (pool removal) · null while open
- `episodes.provenance`: `observed` (default) · `inferred-from-level` ·
  `reopened-after-authority-loss`
- `episodes.corroboration`: `exchange-corroborated` · `status-preexisting`
- `events.repairState`: `none` · `pending` · `resolved` · null (non-drift rows)
- `coverage.class`: `auth-path-observed` · `skipped-unsupported-framework` · `skipped-disabled` ·
  `skipped-identity-unresolved` · `skipped-identity-unenrolled` · `codex-rollout-fresh` ·
  `codex-rollout-stale` · `codex-rollout-undated` · `codex-no-rollout` ·
  `unmeasured-observer-missing-settle` · `unmeasured-observer-double-settle` ·
  `unmeasured-observer-aborted`
- `coverage.authResult`: `clean` · `credential-absence` · `mixed` · null (non-auth/unmeasured rows)
- `credential_read_windows.outcome`: `resolved-read-window` · `cancelled` · null while open
- `credential_read_windows.observationClass`: the closed absence-observation class. The table has
  no `causeClass`, preventing schema-level auth-cause leakage.
- `lastWriteErrorClass`: `busy` · `constraint` · `io` · `unavailable` · `capacity` · `other`
- `machineIdSource` lives on EVENT rows only; coverage and episode rows are attributed by
  `machineId` and reconciled at read time via `supersededHostname` (the earlier "every row"
  phrasing overstated the schema).

## Frontloaded Decisions

1. **Record the `needs-reauth` transitions; no blob probe.** *(NOT reversible — row semantic)*
2. **Ride `QuotaPoller` via the two-fire callback; no shared credential module is modified.**
   The poller-path files are exactly three: `QuotaPoller.ts` (`TokenResolution` gains a fourth,
   NON-reauth `observationOnly` arm — the `reauthNeeded` arm and `pollAccount`'s branch
   unchanged; the narrowed reason type; the callback and sole `pollAccountDirect` lifecycle
   wrapper), the ONE routes.ts direct-caller callsite
   (`reverifyCompletedEnrollment` calls only `pollAccountDirect`), and `PendingLoginStore.ts` (the optional
   injected recorder). Changed files is authoritative for the full list. *(NOT reversible — quantisation baked into published durations)*
3. **`credential-absent-or-unreadable` is honestly fused.** *(NOT reversible — row semantic.)*
   What is lost: "deleted" vs "store had trouble" is not distinguishable in v1; the actionable
   split (dead login vs transient) IS carried by the class structure.
4. **No email, code, token, URL, label, or notice text is ever written.** Enrollment rows contain
   only closed event kinds, opaque internal attempt ids, timestamps, and machine/account ids;
   `expectedEmail`/`userCode`/`verificationUrl` are named as never-copied. Sentinel tests cover
   URL, device-code, bearer/token prefixes, email, and secrets embedded mid-string on success and
   failure paths. *(tightening-only)*
5. **Closed enums on every poller-derived row; no free-text event payload exists.**
   *(tightening-only)*
6. **`attemptId = "<loginId>:<createdAt ISO>:<reissueCount>"`.** *(NOT reversible)*
7. **`login-expired` from writer paths only; the count is a lower bound.**
   *(reversible-forward-only — flipping it mid-series changes a published count's semantic)*
8. **Persisted stable machine id; hostname only as a marked fallback.** *(NOT reversible)*
9. **Status episodes table is the incident authority; store loss reopens with `reopened-after-authority-loss`;
   lost edges recovered as `inferred-from-level`.** *(reversible-forward-only — provenance values
   on written rows persist)*
10. **Bidirectional clock validation; suspect rows retained and flagged.** Tolerance, numeric:
    a row future-dated by >2 min, or older than the previous row's `ts` by >2 min, flags
    `clockSuspect`. *(reversible — `ts` is retained, so the flag is recomputable under a
    different tolerance)*
11. **Pool removal closes both open projections same pass (`outcome:'cancelled'`) — reversible; foreign
    `machineId` rows are refused into the bounded `quarantine` TABLE, not dropped** *(the
    scrubbed quarantine row makes the refusal inspectable without retaining secrets)*.
12. **Always-on; kill-switch read at one funnel; `ledger-started`/`ledger-stopped` exempt and
    mirrored to the watermark.** *(NOT reversible — fleet reach)*
13. **The two-fire callback contract above.** *(NOT reversible — the placement defines what
    `auth-path-observed` meant for every row on disk)*
14. **Retention: 180d / 50k events / whole closed episodes / 20k closed credential-read windows /
    coverage decimation. Incident floor = max(events, coverage); the independent credential-window
    floor invalidates only its own section.** *(NOT reversible — retention deletes evidence; only
    loosening is safe)*
15. **An unreadable/aborted cycle does not count toward `observedHours`** — enforced by writing
    coverage from the settled fire. *(reversible — the stored class makes hours recomputable
    under either rule)*
16. **Refusal evidence uses two bounded carriers:** transactionally committable policy/capacity
    refusals live in SQLite; store-layer failures live in a sibling atomic sidecar; each retains
    180d / 4,320 hourly buckets per closed class. Failure of both carriers is
    a live `evidenceIncompleteSince` which closes into bounded hourly gap buckets; clean-stop is
    withheld until that fact is durable, and intersecting
    or pre-floor public aggregates are null. *(NOT reversible for already-published windows;
    retention may only be loosened forward)*
17. **Ledger admission is durable and bounded:** at most 64 non-disabled, canonically poll-supported cells retain incumbency;
    vacancies refill by stable-id lexical order, disabled/unsupported cells vacate, and a 4,096
    backing-entry scan ceiling fails visibly with bounded count/sample overflow reporting. All
    pool availability, visibility, identity, migration, and recovery semantics are inherited from
    the separately converged pool-authority prerequisite; this feature does not redefine them.
    Pool-authority gaps retain 180d of hourly history in the refusal sidecar and control historical
    aggregate publication. *(NOT reversible for
    historical coverage—changing admission changes which cells accumulated published evidence)*
18. **Credential absence opens a separate non-incident projection.** It never contributes to
    incident counts or time-to-repair, has its own exactly-once open, close/cancel, retention,
    pagination, and truncation semantics, and may coexist with a status episode. *(NOT reversible
    for already-written/public history.)*

## Read surface

`GET /subscription-pool/login-history` (Bearer), registered **before** `GET /subscription-pool/:id`.
Once static foundation capability v1 is installed, always 200 with
`status: 'ok' | 'disabled' | 'pool-unconfigured' | 'pool-invalid' |
'pool-unavailable' | 'store-unavailable' | 'capacity-unsupported'`; this is
intentional because the HTTP request and fan-out completed and these are observed ledger states,
not transport failures. Monitoring and clients branch on the closed `status` field; auth,
malformed requests, and actual route failures retain their normal non-200 semantics. The sole
bootstrap exception is missing/incompatible static foundation code, before the ledger store may be
opened: the shadow-safe stub returns HTTP 503 with closed body
`{status:'ledger-foundation-incompatible',requiredVersion:1,observedVersion:number|null}` and no
history fields. This is not one of the seven normal route states.
`SubscriptionPool.getAvailability()` and `scanAccountsBounded(4096)` are prerequisite
contracts defined by `subscription-pool-authority-foundation.md`. The ledger treats
`unconfigured`, `ready`, `invalid`, and `unavailable` as closed inputs and never converts a
non-ready authority state into an empty pool. Login history maps those inputs to its observational
200 statuses. Every normal local response carries
`maintenance:'rollback-cleanup-pending'|null`; maintenance is orthogonal to status, so a ready
authority with pending rollback cleanup retains `status:'ok'` and the non-null field. Peer fan-out
preserves the same closed maintenance field on the peer result rather than creating a failure row;
local and pool response-schema tests assert both values and their null case. The ledger neither creates,
migrates, repairs, binds, nor backs up pool authority.
`capacity-unsupported` still serves the admitted 64 cells and names overflow cells under
`unmeasuredCells`; it does not disable existing history. Overflow reporting is deliberately NOT a
nested pagination protocol: `{ count | null, countAtLeast, sampleIds, sampleTruncated }`, with at
most 64 lexicographically-smallest scanned stable ids. When the 4,096 scan ceiling binds, exact
`count` is null, `countAtLeast` is populated, and `poolCensusTruncated:true`; no response promises
the complete overflow identity set or materializes an unbounded list. Every response also carries a closed
`diagnostics` block (`storeAvailable`, `capacitySupported`, `peerFailureCount`, `writesRefused`),
and non-ok transitions emit one structured server log, so monitoring need not infer availability
from HTTP status alone. The same closed component state is exported in the existing health
diagnostics, including `maintenance:'rollback-cleanup-pending'|null` orthogonally to the seven
ledger statuses; response-schema tests assert both null and non-null health values so an uptime
consumer can distinguish process-up from ledger-dead without treating maintenance as failure. This route is a data API, not a generic availability probe; `/health`
remains the transport/process health surface. On a
`?scope=pool` response `status` describes THIS machine only.

Raw history is bounded: default window 7d, maximum window 30d, cursor pagination with at most
500 rows and 1 MiB serialized body per page. Rows order by `(ts,id)` and cursors are exclusive
seek cursors, signed/bound to window, filters, account, machine, and scope; malformed, oversized,
expired, or cross-filter cursors return 400. OFFSET pagination is forbidden. Summary queries aggregate in each peer's SQLite
store; pool scope never fetches raw peer history, uses fan-out concurrency 4 with 5s per-peer
timeouts, a 10s whole-request deadline, and at most 32 peers/page with its own bound cursor.
Identical pool summaries share a 60s in-flight/cache entry. Every omitted/timed-out peer remains
a named unmeasured row or continuation-page member. A paged response carries `complete:false`,
`includedPeerCount`, and `remainingPeerCount`; fleet-wide rate/cause/coverage aggregates are null
until every peer page has been combined. Page-local values are explicitly nested under
`pageSummary`, never returned under fleet aggregate names. These limits apply before
materialization, not as a response slice after loading all rows.

`?scope=pool`: self is served locally (never fetched) after filtering `listPoolMachines()` on the
self id; every other registered machine yields cell rows or a NAMED failure row from the peer failure
set defined in Coverage and time (peer-reported states mapped from the peer's own `status`, so a
reachable-but-dark peer cannot silently vanish). All non-cell rows are excluded from every
denominator explicitly and counted in `unmeasuredCells`. Never forwards `?scope=pool`.

`?summary=1` per cell — with `statusEpisodes` and `credentialReadObservationWindows` separated at the TOP LEVEL
of the response, not only by a field, and no aggregate name implying authentication failure
unless exchange-corroborated (a credential-read-window count must not read as "auth failures"):
status rows expose `causeClass`; credential-read windows expose the stored classification as
`observationClass` and are labeled “credential-read observations,” never causes. The split
includes resolved/censored counts, `causeClassCounts`, coverage,
`resolveLatencyUnbounded`, `resolveLatencyFloorMinutes`, `excludedForClockSkew` (split by
direction), `boundaryUncreditedHours`,
`floorPasses`/`floorMinutes` (the heuristic in force), the observedHours clamp flag, the
`machine-id-reminted` marker beside `retentionFloorAt`,
`observedHours` + the observed coverage fraction beside each floored statistic, duration bounds,
`retentionFloorAt`, `windowTruncatedByRetention`, `refusalRetentionFloorAt`,
`refusalWindowTruncated`, `writesRefused`, `lastWriteErrorClass`,
`unmeasuredCells`, `evidence` blocks (mean: ≥3 episodes AND ≥70% coverage; median: ≥2 resolved;
below floor → `null`). If a `capacity` refusal intersects the requested window, rate/cause
aggregates are null (not merely accompanied by a counter) because the numerator may be truncated.

Raw `credentialReadObservationWindows` use the same bounded `(openedAt,id)` seek cursor as status
rows, with an independent maximum page size of 200 and `nextCursor`; a request never combines the
two cursor domains. Each window returns only id, accountId, machineId, openedAt/closedAt,
observationClass, outcome, stamped floors, and derived evidence maturity. Summary returns open,
resolved, cancelled, duration quantiles, firstRetainedAt, retentionFloorAt, and
windowTruncatedByRetention separately from status statistics. Queries beginning before the
credential-read floor mark that section truncated and null its duration/retuning statistics.

Invalidation is closed and field-specific:

| Intersecting condition | Raw retained rows | Diagnostics/floors/counters | Temporal or health aggregate |
|---|---|---|---|
| transactional validation refusal only | available | populated | available; rejected input was not an admissible observation |
| capacity refusal | available | populated | `null` |
| historical store-layer refusal bucket after recovery | available | populated | `null` |
| closed incomplete-hour bucket after recovery | available | populated | `null` |
| live `evidenceIncompleteSince` with readable store | available | populated | `null` |
| current `status:'store-unavailable'` | unavailable (never represented as empty history) | independently carried sidecar/lifecycle diagnostics only | `null` |
| current `status:'pool-invalid'` | retained ledger raw rows remain readable | scrubbed pool availability + durable authority-gap boundary | per-cell historical aggregates available only for windows ending before the gap; intersecting census/completeness/health aggregates `null` |
| current `status:'pool-unavailable'` | retained ledger raw rows remain readable | scrubbed pool availability + durable authority-gap boundary | per-cell historical aggregates available only for windows ending before the gap; intersecting census/completeness/health aggregates `null` |
| event/coverage/refusal pre-floor truncation | available from floor forward | populated | `null` |

“Temporal or health aggregate” means episode/rate/cause counts, resolved/unresolved/censored
counts, duration and resolution latency, healthy/absence/observed hours and coverage fractions,
pre-escalation/boundary hours, and every evidence block. Structural status, named peer failures,
raw rows that survived, retention/refusal floors, truncation flags, and refusal/diagnostic counters
remain populated. Local and pool tests assert every column, not only rate/cause fields.

Fleet summaries expose `codexAuthUnknownCells` separately and exclude every demand-proxy row from
auth-health values by construction; the accepted Codex limitation is therefore prominent rather
than a flattering zero.

Coverage/`observedHours` pseudocode:

Denominator membership, closed: ONLY `class == auth-path-observed` rows with `signalKind: 'auth'` count
toward `observedHours` and the ≥70% fraction. No `signalKind: 'demand-proxy'` row enters an
auth-health denominator. `auth-path-observed` means only “the poller produced a settled auth-path
observation”; it does NOT mean credential health was independently verified.
Membership is keyed on the type, not a name prefix; every `skipped-*` and `unmeasured-*` class is
excluded. Pre-decimation `representsMinutes` is the fixed 15-minute
  ledger bucket, independent of configured poll cadence; the gap cap uses
  `max(2 × 15m, 2 × representsMinutes)`. Worked example: a cell measured every 15 min for 60 days, then decimated beyond day 7
to one row/hour with `representsMinutes: 60` — pre-decimation deltas cap at 30 min each and sum
to the true span; post-decimation deltas cap at 120 min (2 × representsMinutes) and still sum to
the true span, so the fraction is unchanged (the unit test pins exactly this).

Within observed auth time, `healthyObservedHours`, `credentialAbsenceObservedHours`, and
`mixedAuthObservedHours` are separate. All count toward observation coverage. Only clean-only
buckets claim a usable token; absence-only buckets enter absence time; mixed buckets enter neither
split and remain explicit. Shared-store detection treats `mixed` as having observed absence.

```
observedHours(cell, window):
  rows = coverage rows for cell in window with class == auth-path-observed AND signalKind == auth, ordered by ts
  // each row carries pollIntervalMsInForce for disclosure and representsMinutes (15 before
  // decimation; 60 after hourly decimation)
  // pollIntervalMsInForce = QuotaPoller's configured pollIntervalMs (default 900_000) at write
  // time — the base cadence, never the triggering caller's; the ledger holds it from
  // construction so the routes.ts direct-caller fire records the same value
  deltas = pairwise ts gaps, each capped at max(2 × 15 * 60_000,
                                               2 × row.representsMinutes * 60_000)
  // pollIntervalMsInForce is disclosure-only here. The operative units are the fixed bucket
  // and representsMinutes; convert its MINUTES with ×60_000.
  return min(sum(deltas), window length)     // clamp reported when it binds
  // zero or one measured row intentionally credits ZERO observed hours: a point observation does
  // not prove the surrounding 15-minute interval. Singleton behavior is conservative and pinned
  // by unit/API tests; evidence floors therefore require at least two measured rows.
  // each gap is capped using the LATER row's fields (it credits the span the retained row
  // stands for); the decimation-boundary case is in the unit test
  // interior-only by design: no credit from window.start to the first row or last row to
  // window.end — deliberately conservative; the uncredited boundary time is reported as
  // boundaryUncreditedHours so a null rate near a restart or retention edge is explainable
```

## Decision points touched

| Point | Class (`invariant` or `judgment-candidate`) | Floor / justification |
|---|---|---|
| Rising edge | `invariant` | A comparison of two observed values of one field (the settled re-read vs the open-episode row, which is the durable prior). |
| Falling-edge attribution | `invariant` | Both edges keyed on the attributed id from the same re-read — the round-4 version left the account choice unmade, which made this row an arbiter; the re-read rule closes it. |
| `causeClass` mapping | `invariant` | Total over the exported narrowed union + `unrecognized-reason` fallback; test enumerates every REACHABLE member; producer-absence is pinned separately for the two excluded `RefreshFailReason` values. |
| Expiry dedupe | `invariant` | Three-part `attemptId`, injective over issue/reissue/splice (verified: `reissue()` bumps `reissueCount`, never `createdAt`). |
| Enough evidence for a rate? | `invariant` | Numeric floors only: mean ≥3 episodes AND ≥70% `auth-path-observed` coverage; median ≥2 resolved. No unnumbered threshold remains. |

## Multi-machine posture

Identity authority matrix (normative):

| Artifact/use | Binding source |
|---|---|
| ledger stable rows/directory | coordinator machine id when available; otherwise watermark-minted id, with explicit origin |
| first-boot fallback ledger rows | normalized hostname, later reconciled only through `supersededHostname` |
| peer fan-out identity | registered mesh machine id; never a row's hostname fallback |
| foreign quarantine decision | current stable ledger machine id versus directory watermark id |

| Surface | Posture | Notes |
|---|---|---|
| `state/subscription-login-ledger/` (db, WAL/SHM, watermark) | `machine-local` | `machine-local-justification: physical-credential-locality` — the rows are per-machine observations of credential slots that physically live on one disk; the merge key never collapses cells across machines. Open question 1 confirms the unified READ posture. |
| `state/subscription-login-ledger-refusals.json` (sibling failure-evidence sidecar) | `machine-local` | `machine-local-justification: physical-credential-locality` — it records failures of the same machine-bound credential observer and is never replicated; unified reads fetch its effects from that machine. Its sibling placement is what survives DB-directory quarantine. |
| `GET /subscription-pool/login-history` + rollup | `unified` | `listPoolMachines()` fan-out, named failure rows incl. peer-reported states. |

Pool-authority identity and replication posture belong to the prerequisite spec; this table covers
only artifacts introduced or read by the ledger.

## Self-heal posture

No watcher, no timer, no notice source; rides `QuotaPoller`. Degradations are typed counters and
the watermark; nothing notifies.

## Changed files

`src/core/SubscriptionLoginLedger.ts` (new) · `src/core/QuotaPoller.ts` (`TokenResolution` gains a fourth NON-reauth `observationOnly` arm —
the `reauthNeeded` arm and branch unchanged; narrowed `markNeedsReauth` reason type; the
`'usage still auth-failed after refresh'` literal → `still-authfailed-after-refresh`; the
two-fire callback) · `src/core/PendingLoginStore.ts` (`save()` gains a discriminated durable
result, `{ persisted:true } | { persisted:false,errorClass }`, instead of swallowing all errors.
Every mutation is copy-on-write: `this.store` swaps to the candidate only after durable success;
on failure the prior snapshot remains authoritative, so a later successful save cannot smuggle an
unrecorded earlier transition onto disk. Routes return their existing typed persistence failure;
the optional recorder fires only after `persisted:true` and a disk re-read, not an in-memory
`get`; failed persistence emits no lifecycle claim; callback failure is caught/counted without
changing login state; expiry found by `get`/`list` uses `eventKey` uniqueness so repeated reads
cannot multiply it) ·
`src/commands/server.ts` · `src/server/routes.ts` ·
`src/server/fileRoutes.ts` (**dual-root pairs**, matching the live precedents:
`state/subscription-login-ledger/` AND `.instar/state/subscription-login-ledger/`, the sibling
`state/subscription-login-ledger-refusals.json` and `.instar/state/subscription-login-ledger-refusals.json`
(including atomic temp siblings), plus the
foreign-directory prefix — the round-4 entry named only the legacy root, which the file's own DUAL-ROOT
comment says never matches a production path, leaving the db dashboard-editable; the deny test
asserts against the PRODUCTION root form) · `src/core/PostUpdateMigrator.ts` +
`src/scaffold/templates.ts` (port-parameterized `SUBSCRIPTION_LOGIN_LEDGER_CLAUDEMD_SECTION(port)`)
· `src/server/CapabilityIndex.ts` · `src/core/BackupManager.ts` (`BLOCKED_PATH_PREFIXES` gains
explicit dual-root prefixes for `state/subscription-login-ledger`).
**No shared credential module is modified.**

## Rollback

Kill switch; then delete the active `subscription-login-ledger/` directory, any quarantine
intent, the sibling `subscription-login-ledger-refusals.json` plus atomic temp siblings, AND the
bounded `subscription-login-ledger.foreign-<timestamp>/` directory after a clean close. The
`BLOCKED_PATH_PREFIXES` entry is retained one release past removal. Rows on machines
the operator does not administer are not retracted (no PII by Decision 4).
Pool authority is untouched by ledger rollback; its lifecycle belongs exclusively to the
prerequisite feature.

## Testing

- **Unit:** every REACHABLE `causeClass` member producible from its named callsite; the two
  unreachable members pinned; a deleted credential (resolver returns absent) OPENS a credential-read window —
  the round-4 blindness test; transient reasons never flag; drifted pass never opens on one id
  and closes on another; restart independently preserves one open status episode and one open
  credential-read window; refused edge recovered as `inferred-from-level`; concurrent passes
  cannot double-open either projection; Cartesian overlap cases are generated from the canonical
  product-state reducer; three-part `attemptId` across
  reissue; retention floors incl. the max-of-both rule and coverage decimation; sentinel
  credential/email never in a row (success + failure paths, `@` assertion); 0600 on db+wal+shm
  under umask 022; watermark schema round-trip + foreign-machineId ignored; clock-suspect rows
  retained; `eventKey` uniqueness survives reopen and concurrent expiry callbacks while two
  distinct code submissions in one attempt both persist; forced PendingLoginStore rename/write
  failure followed by a successful different mutation proves the failed candidate neither
  persists nor later appears without its event; coverage compaction
  preserves its fraction at the 320k boundary. Absence counts as measured while contributing
  only to `credentialAbsenceObservedHours`; clean↔absence in both within-bucket orders yields
  `authResult:'mixed'`, increments `mixedAuthObservedHours`, contributes to neither split metric,
  and pins commutative evidence `ts`, interval fields, `lastObservedAt`, byte-equivalent semantic
  rows, and unchanged observed coverage. Unit cases also reverse same-result arrivals and prove the
  absorbing branches `mixed⊔clean`, `mixed⊔absence`, and `mixed⊔mixed` (incoming producers emit
  raw clean/absence, so persisted-mixed + each raw input is the production path). Clock-suspect
  absence writes diagnostics/coverage without accumulator mutation; clock-suspect status edges
  mutate authority but never duration stats. Refusal buckets survive restart and distinguish
  inside/before/after-window capacity failures plus a later different error class. Window unit
  tests cover open/close/cancel/restart, coexistence with every status state, 180d/20k boundaries,
  protected open rows, atomic cap-at-close eviction (including cancellation), the invariant that
  closed count remains ≤20k, floor advancement, and pre-floor nulling.
- **Integration:** route, filters (quote-bearing → empty), summary shape; `?scope=pool` named
  failure rows including the peer-reported states; deny of the PRODUCTION-root db path;
  concurrent manual polls invoke one provider poll, the cache expires at 60s, base-poll-interval
  boundaries admit separately, timer/proactive/manual overlap coalesces coverage without
  suppressing episode edges, and admitted coverage never exceeds 96×cells/day; boot at 64 then
  add/remove cell 65 verifies typed overflow and recovery; non-default and mid-run poll cadence
  changes preserve both fixed 15m row bounds and correct observed coverage; second-instance
  override is readonly. Both root
  forms deny active and foreign ledger directories; backup/restore excludes them; only one foreign
  directory survives; directories remain 0700 and files 0600 under umask 022; rollback removes
  them. An undeletable prior quarantine refuses the next mismatch before rename. A max-sized foreign store
  is directory-renamed without row import; fault injection after every intent/rename/fsync step
  proves restart completion/rollback. Cursor tests pin `(ts,id)` seek order, concurrent insert/retention behavior,
  scope binding, and malformed/oversized/cross-filter refusal. Pool tests pin 32-peer pages, 10s
  overall deadline, concurrency 4, named omissions, partial-summary fields/null fleet aggregates,
  and shared in-flight/cache behavior. Invalid/error/timeout submit paths produce no
  `code-submitted` row; each named processed outcome does.
  Real timer/proactive/manual overlap drives clean+absence in both arrival orders through the
  SQLite UPSERT, then local and pool APIs assert identical `mixedAuthObservedHours`, zero clean/
  absence split contribution, shared-store suspicion, preserved edge commit, and restart parity.
  Window integration tests pin independent cursor/page schema, raw/summary separation, retention
  truncation, and zero contribution to incident metrics. Liveness tests cover slower cadence, mid-run cadence changes, restart migration defaults, local
  and peer states, and a genuinely stalled writer.
- **Summary boundary:** local and pool integration tests assert an intersecting refusal bucket
  nulls rate/cause aggregates, while refusals outside the window do not; BEGIN/INSERT/COMMIT busy
  and I/O fault injection proves store-layer failures reach the independent sidecar, and a failed
  sidecar write latches an honest evidence-incomplete result until closed into durable hourly gap
  buckets. Tests query wholly before, inside, and after one and multiple recovered gaps, including
  restart after recovery. Retention tests
  cross day 180, restart after a long outage, exercise every closed refusal class, prove the hard
  bound and bounded cleanup, and null queries predating either refusal floor. Tombstone tests also
  prove expired rows are physically removed under the independent 5k sweep budget. Adverse observation
  fields retain the production response shape.
- **Migration parity:** idempotent `PostUpdateMigrator` test on an existing agent, including its
  configured port in the inserted CLAUDE.md section; backup/restore tests prove db/wal/shm and
  watermark remain excluded. A production UPDATE-path E2E starts from the prior fixture and
  proves the route alive after migration.
- **Health surface:** integration tests assert `/health` maps healthy, store-unavailable, and
  capacity-unsupported ledger component states while process health remains up. The component
  preserves all seven route states distinctly: `ok`, `disabled`, `pool-unconfigured`,
  `pool-invalid`, `pool-unavailable`, `store-unavailable`, and `capacity-unsupported`; integration tests assert every mapping.
  A separate bootstrap dependency state reports `ledger-foundation-incompatible` without opening
  the store; it is not folded into the seven runtime component states.
  Production-init
  E2E induces a real ledger-store failure and observes the non-no-op diagnostic through the wired
  health dependency.
- **E2E (production init):** route-order/shadow tests prove incompatible static capability returns
  the exact closed 503 bootstrap body rather than falling into `/:id`; compatible v1 returns 200
  with the ledger payload and NOT an account-not-found body; a
  driven `needs-reauth` transition lands an episode end-to-end. Production-created dependencies
  additionally drive one transactional capacity refusal and one DB-layer fault, prove local and
  pool summaries null, restart with the refusal/floor intact, and exercise dual-carrier failure
  through fail-closed shutdown/recovery. A time-controlled production fixture crosses day 180 and
  proves the real retention trigger bounds refusal buckets and physically expires tombstones.
  Direct-observer unit tests cover zero/one/double settle, throw, cancellation, and timeout;
  pollAll tests throw before first settle, midway through a multi-cell pass, and after buffering an
  episode-opening edge, proving every cell in the original pre-registered ADMITTED census receives exactly
  one valid/skipped/aborted terminal coverage outcome and `finally` commits only valid cells.
  Skipped tests cover zero/double `finishSkipped`. Integration/E2E through the real
  post-enrollment reverify callsite proves exactly one reducer/coverage commit and no false
  missing-settle counter. Active store-unavailable tests prove raw rows are unavailable—not an
  empty array—locally and as named `peer-store-unavailable` in pool fan-out.
  Production-path integration aborts the operator poll request mid-pass, drives the real provider
  timeout/AbortSignal path, throws before and midway through real `pollAll`, exercises actual
  disabled/unsupported/identity-unresolved continues, and makes `pollAccountDirect` throw/timeout
  through reverify. It asserts established route results/errors are unchanged, unfinished cells are
  aborted and denominator-excluded, invalid buffered edges do not commit, and pool summaries agree.
  Production-init E2E includes one cancellation with a forced finish + dual-carrier failure.
  Production-init E2E also drives overlapping status/window lifecycles across restart and retention,
  proves the hard window cap and floor, and verifies incident counts/time-to-repair are unchanged.
  It additionally creates a mixed bucket through real concurrent producers, crosses hourly
  decimation and restart, and proves the commutative semantic row and all three split metrics remain
  identical on local and pool reads.
  Dedicated tests compare success+finish-failure, poll-throw+finish-failure,
  cancellation+finish-failure, and dual-carrier failure against byte-equivalent authority outcomes.
  A very large synthetic pool proves observer state and writes remain ≤64 cells, overflow creates
  no coverage rows, pool-internal instrumentation proves ≤4,096 backing entries examined with
  O(64) ledger state/no full copy or sort, and
  count/sample reporting keeps every response bounded and visibly lower-bounded when truncated.
  Prerequisite-contract tests inject each closed pool availability state and prove the ledger
  never treats invalid/unavailable as an empty census. A production integration fixture uses the
  real prerequisite implementation to prove the scan examines no more than 4,096 backing entries,
  incumbent lookup remains bounded, and no later ledger path materializes the full pool. The
  authority implementation's migration, identity, recovery, backup, and load-taxonomy tests live
  only in `subscription-pool-authority-foundation.md`.
  Closed reducer, retention, refusal-carrier, and identity matrices are executable table-driven
  golden fixtures generated from one enum/state-machine source; normative prose tables are
  generated or CI-verified row-for-row against it, and schema/prose parity fails on drift.
  Retuning unit boundaries cover day 29/30, resolved 19/20, conjunctive semantics, empty/retained/
  mixed-floor cohorts, and quantile/correlation/overlap outputs. Integration pins response fields,
  statistics, and provisional labels. Production-init E2E derives eligibility on demand across
  restart and asserts zero attention item, message, job, timer, or persisted delivery side effect.
- **Existing assertions updated, named (Zero-Failure Standard):**
  `tests/unit/quota-poller.test.ts` "defaultTokenResolver never returns a non-oauth token"
  asserts `toBeNull()` for the shape-check failure; under the `observationOnly` arm it must
  become `toEqual({ observationOnly: true, reason: 'credential-token-shape-invalid' })`. The
  provider/framework early return keeps returning bare `null` — those assertions stand. (That
  test darwin-skips, so the break would surface only in Linux CI — named here so it is fixed
  with the change, not discovered red.)
- **Wiring integrity:** the callback fires with the DEFAULT token resolver on the production path
  (no injected `tokenResolver`), `developmentAgent: false`, `credentialRepointing.enabled`
  absent; a codex account yields a `codex-rollout-*` coverage row, including the undated case.

Framework scope is the subscription frameworks the pool actually supports today: Claude and
Codex. Gemini CLI and future engines are explicitly emitted as `skipped-unsupported-framework`
until their own typed subscription-account adapters exist; the closed coverage contract makes
that absence visible rather than silently treating them as healthy.

## Resolved operator decisions

**All blocking operator decisions are RESOLVED as of 2026-08-26 (Justin, topic 33890,
verified operator). Implementation is operator-authorized once the formal convergence gate is
earned; the header status is the single source for remaining external-review/tag gates.**

1. **Read/replication posture — RESOLVED: unified-read-only.** The stores stay machine-local
   under `physical-credential-locality`; the unified `?scope=pool` READ is sufficient and rows
   do NOT additionally replicate. Operator confirmed 2026-08-26.
2. **Codex auth signal — RESOLVED: demand-proxy only for v1.** The `codex-rollout-*` freshness
   signal is v1's codex coverage; the `auth.json` shape check is NOT built now. Operator
   confirmed 2026-08-26. Additive later; changes no written row.
   *Stated limit carried to the operator at decision time:* freshness measures DEMAND, not
   login liveness — a codex account whose login died while unused reads identically to a healthy
   unused one. The operator accepted this trade for v1 and was told the direct check is available
   on request.
3. **Review stop point — RESOLVED: bounded 80/20 convergence.** After auditing the full journey,
   the operator ratified an 80/20 boundary on 2026-08-26: accept explicit limitations rather than
   expand the threat model or duplicate every micro-fault at every test tier. Required external
   review runs before the terminal pair. Convergence then requires two full zero-DESIGN reviews by
   the frozen reviewer set on one semantic body hash. Copy/status-only edits do not reset that pair;
   they receive one precision verification. Passing the terminal pair ends prose review unless
   implementation evidence falsifies a named invariant.

**Operator constraint attached to the go (2026-08-26): "folded into one-time setup work per
machine."** The ledger SATISFIES this by requiring zero per-machine setup — it ships with the
release, self-creates its store on first boot, and rides the existing `QuotaPoller` cycle; there
is no per-machine enable flag, pairing step, or login in its path. Any future change that
introduces a per-machine setup step to THIS feature violates a stated operator constraint and
must go back to the operator first.

## Maturation plan

- **test-agent-live:** run the unit/integration/production-init fixtures with synthetic subscription
  accounts, including store refusal, restart, bounded admission, and local/pool reads; no real
  credentials or login codes enter fixtures.
- **dev-agent-live:** enable observation on Echo after foundation capability v1 is live; verify at
  least eight normal QuotaPoller cycles, one restart, local history, pool fan-out, and zero
  credential material in rows/logs.
- **fleet:** ship default-on with the normal release after the dev rung passes; it requires zero
  setup and remains machine-local with proxied-on-read pool history.
- **graduation criterion:** 48 consecutive dev-agent hours with no ledger-caused poll failure, no
  unbounded response/store growth, no secret-bearing row, correct explicit degraded states during
  injected store/pool failure, and successful readback after restart.
- **dark-window:** development-agent only for at least 48 hours; fleet rollout remains dark until
  the graduation criterion passes.

## Open questions

*(none)*
