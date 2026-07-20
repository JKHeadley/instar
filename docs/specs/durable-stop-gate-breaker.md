---
title: "Durable Stop-Gate Breaker"
slug: "durable-stop-gate-breaker"
author: "Instar-codey"
parent-principle: "No Unbounded Loops"
status: "approved"
approved: true
approved-by: "Justin (explicitly delegated class review + standard registration/upgrade in throughput lane, 2026-07-19)"
eli16-overview: "durable-stop-gate-breaker.eli16.md"
review-convergence: "2026-07-20T00:12:52.944Z"
review-iterations: 10
review-completed-at: "2026-07-20T00:12:52.944Z"
review-report: "docs/specs/reports/durable-stop-gate-breaker-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Durable Stop-Gate Breaker

## Problem statement

The `UnjustifiedStopGate` has a correct fail-open contract: if its LLM authority
cannot return inside the two-second Stop-hook deadline, the session is allowed to
stop. It also has an in-memory circuit breaker that stops repeatedly spawning a
known-slow provider after three failures. The circuit breaker forgets its state on
every server restart, however. Instar releases routinely restart the server, so a
still-broken provider path is probed again after each update and emits another
pair of `[DEGRADATION] unjustifiedStopGate.timeout: >2000ms` feedback records.

Live evidence on the development agent contains 179 such records from
v1.3.431 through v1.3.884, including 2026-07-19. PR #559 reduced the within-process
flood, but did not make the brake survive the lifecycle event that repeatedly
re-opens it. This is an instance of the registered `unbounded-self-action` defect
class: a restart resets the steady-state bound while the pressure remains.

The fail-open telemetry is truthful and must remain. The defect is not that a
timeout is reported; it is that routine process lifecycle resets allow a known
failure class to be re-driven as though it were new.

## Class review (before instance repair)

### Standard gap

`No Unbounded Loops` requires backoff, a breaker, a cap, and a sustained-failure
test. It currently proves those properties only within one object/process
lifetime. It does not say what happens when the process restarts while the
external pressure persists. A volatile breaker can therefore satisfy the words
while failing the convergence invariant in production.

This change upgrades the standard: whenever routine restart/reconstruction is an
ordinary lifecycle input and the trigger survives it, the convergence state must
either survive restart or reconstruction must itself be proven reset-safe. A
restart may not mint a fresh retry budget against unchanged pressure.

### Process gap

The self-action convergence ratchet drives N and 2N ticks but never reconstructs
the controller between them. The `UnjustifiedStopGate` breaker tests likewise use
one instance. Review therefore had no structural way to distinguish durable
convergence from process-lifetime convergence.

This change extends the ratchet with a restart-survival posture and a pinned
restart-under-pressure assertion. The stop-gate becomes a registered controller
model backed by the real durable breaker seam. Future controllers whose pressure
survives restart must declare and prove the same posture.

### Terminology

- **resolved door**: the concrete CLI/provider selected for this component.
- **failure tail**: ordered alternate doors the shared router may try.
- **authority seam**: the single call boundary where the Stop gate asks for a
  structured LLM verdict.
- **pressure**: repeated Stop attempts while the provider remains unusable.
- **breakerOpen fail-open**: skip the provider call and allow the Stop event,
  returning the structured `breakerOpen` reason.

## Proposed design

### 1. Durable breaker state in `StopGateDb`

Add an `authority_breaker_state` row keyed by a non-secret fingerprint of the
resolved Stop-gate routing configuration (framework/category override and failure
tail) containing:

- `consecutive_failures` (non-negative integer),
- `open_until` (epoch milliseconds), and
- `probe_lease_until` (epoch milliseconds; zero when no half-open probe owns the
  lane), and
- `first_opened_at` plus `suppressed_count` (inspectable non-notifying outage
  duration/volume), and
- `updated_at` (epoch milliseconds).

`StopGateDb` exposes a narrow `StopGateBreakerStateStore` contract: synchronous
load, atomic record-failure, and reset. The failure transition runs in one SQLite
transaction (`read current → increment → calculate open_until → UPSERT`), so
overlapping evaluations cannot lose an increment. The row contains no prompt,
message, reason, identity, or other sensitive content.

The fingerprint is `sha256(stableJson({ schema: 1, defaultFramework,
gateCategoryFramework, stopGateOverride, failureSwap }))`, where the four routing
values come from the effective `sessions.componentFrameworks` resolution used at
boot. Keys are sorted before hashing. Release/package version, machine id, agent
id, credentials, timestamps, breaker state, and request content are forbidden
inputs. A real change in active/resolved doors intentionally creates a new key;
an ordinary release with the same route does not.
Executable-path, binary-version, environment, and credential changes are
intentionally excluded because they are mutable/secret-adjacent and not stable
routing identity. Repairing one may therefore wait at most the existing
five-minute cooldown before its automatic probe; `instar gate reset-breaker`
provides an authenticated explicit immediate-probe action and is audited.
When open, `instar gate status` prints both the exact next-probe time and that
reset command so a repaired credential/installation does not look ineffective.
The alternative—hashing a credential/account “generation”—was rejected because
not every provider exposes a stable non-secret generation, environment changes
are unbounded/unstable key inputs, and credential identity would enlarge the
durable metadata surface. The bounded automatic probe plus explicit reset gives
repair responsiveness without persisting credential-derived identity.

| Change | New key? | Reason |
|---|---:|---|
| Package/release version only | No | Lifecycle churn must not reset pressure state. |
| Default or gate framework changes | Yes | The concrete provider route changed. |
| Failure-tail membership/order changes | Yes | Recovery route semantics changed. |
| Enabled provider added/removed from effective resolution | Yes | The resolved door set changed. |
| Credential repaired/removed | No | Auto-probe within five minutes or explicit reset. |
| Binary path/version or environment changes | No | Unstable local input; auto-probe/reset handles it. |

Half-open admission is also atomic. `tryAcquireProbe(now, leaseMs)` updates the
row only when the cooldown has expired and no unexpired probe lease exists. One
caller receives `true`; concurrent callers receive `false` and take the instant
`breakerOpen` fail-open path. The lease is bounded to the client timeout plus a
small settlement margin, so a process crash cannot strand the breaker. Success
resets the row; failure clears/replaces the lease while reopening the cooldown.
The threshold transition is exact: `next = consecutive_failures + 1`; persist
`next`; when `next >= breakerThreshold`, set `open_until = effectiveNow +
cooldownMs`. Failures 1–2 remain closed at the default threshold 3, and failure 3
opens. A failed half-open probe keeps the count at/above threshold and sets a
fresh cooldown without changing its specific failure kind.

Production has one server writer by the existing `SingleInstanceLock` invariant.
The database remains WAL-mode and the transition uses `BEGIN IMMEDIATE` so two
handles in restart-adjacent/integration scenarios serialize before reading. A
fixed 10ms SQLite busy timeout consumes at most 0.5% of the 2000ms Stop-hook
budget and leaves the authority budget intact. Lock timeout or
any store error is contained as persistence degradation and falls back to the
existing in-memory brake/fail-open result; storage can never hang the hook.
The persistence degradation is reported once under the distinct feature
`unjustifiedStopGate.breakerPersistence`, so memory-only operation is never
silent. That signal enters DegradationReporter's durable open-event lifecycle;
Guardian's existing persistent-open review can therefore resurface it until
recovery, rather than relying on one process-local log line. An integration test
holds a second-handle write lock past 50ms and proves
bounded return latency, fail-open, and the truthful degradation signal.
Supported production concurrency is one server process with overlapping async
Stop evaluations. A second live server sharing the state directory is denied by
`SingleInstanceLock`; restart overlap and two raw SQLite handles exist only as
defense/integration cases, and the transaction/lease keeps those accidental
cases bounded rather than treating multi-server operation as supported.
No ordinary evaluation performs a new database read: construction hydrates once,
an open in-memory deadline short-circuits, and only failure settlement or the
once-per-cooldown half-open acquisition writes. StopGateDb is contractually on the
machine-local state filesystem and already writes each evaluation event there.
A 1,000-transition performance test requires p99 under 10ms on the CI host; DB
open/corruption failure keeps the pre-existing server behavior (authority unwired,
mode off), rather than publishing a half-initialized gate.

| Path | Synchronous database work and budget |
|---|---|
| Closed admission | None. |
| Open admission | None; memory deadline only. |
| Half-open acquisition | One atomic transition; 10ms lock wait maximum. |
| Failure settlement | One atomic transition; 10ms lock wait maximum. |
| Startup hydration | One row read before routes publish; outside Stop-hook latency. |
| Store-error fallback | Abort after 10ms lock wait and continue in memory/fail-open. |

### 2. Hydrate and persist at the authority seam

`UnjustifiedStopGate` accepts the optional store. Construction synchronously
hydrates breaker state before the object is published to the route; this is
possible because `better-sqlite3` is synchronous. A load error is contained and
starts with the existing memory-only closed state. There is no async hydration
race and the Node event loop plus the atomic database transition covers
overlapping evaluation settlements. Provider failure persists the increment and
open-until value; provider reachability resets both memory and disk. Persistence
errors are contained: the gate preserves its existing in-memory brake and
fail-open behavior, because breaker storage is resilience infrastructure rather
than authority.

When the store is readable, durable state is the admission source of truth and a
successful durable transition immediately replaces the in-memory mirror. Memory
is used only after a contained store failure; the next successful durable load or
transition re-synchronizes it. A memory-only failure may conservatively open
earlier, but disagreement can never bypass a readable durable open/lease row.

That fail-open direction is the named Stop-gate exception to the general
gating-LLM fail-closed rule: missing a drift-correction `continue` lets the agent
stop and hand control back to the operator; failing closed would forcibly keep a
session running without an authority verdict. The repository already registers
this exception in `tests/unit/no-silent-llm-fallback.test.ts`. No brittle fallback
is introduced—the outcome is availability pass-through plus a truthful signal.

The existing cooldown remains the recovery probe. Admission uses
`effectiveNow >= clampedOpenUntil`. `effectiveNow` is
`max(rawNow, min(updatedAt, rawNow + cooldownMs))`; stored deadlines are clamped
to `effectiveNow + cooldownMs` (or `effectiveNow + leaseMs`) and clamped values
are persisted on the next transition. `recordFailure` calculates from that
effective time; lease settlement requires the matching lease token, so a stale
caller cannot close a newer lease. Once `open_until` expires, one
half-open evaluation is admitted through the atomic lease. A successful provider response resets durable
state. A failed probe re-opens and persists the breaker without emitting another
timeout degradation (the existing `breakerOpen` reporting rule).

| Stored/live clock case | Effective behavior |
|---|---|
| Normal time | Honor the stored deadline and admit one probe after expiry. |
| Wall clock moves backward | Use bounded stored update time; never extend beyond one cooldown/lease. |
| Wall clock moves forward | Treat expiry as eligible for one atomic half-open probe. |
| Corrupt far-future deadline | Clamp to one cooldown/lease beyond effective time. |
| Stale `updated_at` | Current wall time wins; stale metadata cannot extend the outage. |

“Successful authority response” means a transport response that also passes the
existing JSON/rule/evidence contract. Malformed, empty, rule-invalid, and
evidence-invalid outputs advance the same durable unusable-authority breaker while
retaining their specific failure kind for observability. Only a usable structured
verdict resets it, so a semantically broken provider cannot flood indefinitely.

The routing fingerprint prevents stale suppression after an operator changes the
provider/framework configuration: a changed route gets a fresh key and may probe
immediately. Routine release version changes are deliberately excluded from the
key, because including them would recreate the presenting restart-reset defect.

### 3. Structural class guard

Extend `SelfActionController` with an explicit restart posture:

- `pressureSurvivesRestart: true` requires `restartUnderPressure`, which receives
  only the fixture and sink—never the prior controller instance or closure—and
  rebuilds from a fixture-owned, explicitly named `durableState` value.
- `pressureSurvivesRestart: false` requires a reason showing why reconstruction
  is reset-safe.

The convergence ratchet reconstructs every `true` controller at parameterized
25%, 50%, and 75% positions, and also on every tick in a short restart-storm
fixture, while asserting the same `boundK` and per-target bound. A meta-test
rejects a controller with no restart posture. Register a
`stop-gate-authority-probe` model whose durable state uses the same
`StopGateBreakerState` transition helpers as production.
This class guard is not speculative: existing kill-ledger, reconciliation,
provider-dark brake, and topic-quarantine controllers already declare durable
restart-safe posture in the same registry; the ratchet prevents their future
models from silently regressing to process-local convergence too.

The API makes the carry surface machine-checkable: a restart callback has no
parameter through which hidden instance state can pass, and the only shared
mutable object offered by the pinned fixture is its declared `durableState` map.

This is intentionally a small extension of the existing controller ratchet, not
a generic workflow engine or property-based state machine: the production
invariant is one reconstruction boundary and a fixed action-count bound, and the
current registry already supplies the deterministic pressure fixture, action
sink, and N/2N proof. A second framework would duplicate those class guards.
The transition helper also receives an exhaustive table/state-machine unit test
over closed → failing → open → concurrent half-open → failed/successful settlement
→ restart, including reconstruction at every state. The midpoint ratchet proves
the class-wide action bound; the transition table supplies lifecycle breadth.
The finite transition table crosses clock direction, corrupt clamps, stale/current
lease tokens, store success/failure, and settlement ordering. These are closed
enums with explicit boundary timestamps, so exhaustive deterministic cases are
more reproducible than random generation and fail with a named transition.

### 4. Observability and feedback disposition

No timeout signal is relabeled, swallowed, or marked resolved by this PR. A real
pre-breaker timeout still emits the existing degradation. `breakerOpen` remains a
structured, persisted gate outcome and intentionally does not emit a repeated
degradation. This keeps the authority-path fault visible once while preventing
routine restarts from manufacturing recurrence.

Ongoing outage remains inspectable without another notification loop: the
existing Stop-gate hot-path/status read adds the durable breaker state (`open`,
`openUntil`, failure count, probe lease, `firstOpenedAt`, and `suppressedCount`).
The reset route is registered as a machine-local write surface: it changes only
this host's physical-provider breaker in the git-sync-excluded StopGateDb.
Each rejected admission atomically increments the metadata-only suppression
counter at most once per minute (coalescing in-memory increments); the duration is
derived on read. Guardian/feedback retains the original
timeout event. No daily heartbeat is added because it would recreate a recurring
feedback producer for a condition already represented durably.
Counter flush is best-effort on an unreferenced post-response timer, never awaited
by the Stop hook. Lock timeout drops that counter delta and reports no new
degradation—the count is observability-only and may undercount rather than feed
pressure back into the critical path.
The ordinary `breakerOpen` admission path performs no synchronous database read
or write. Only the optional coalesced counter timer performs best-effort disk I/O.
The counter is explicitly approximate. One process-local accumulator exists per
breaker key and schedules at most one durable flush per key per minute; all
sessions share it. A crash may lose the unflushed delta. It is a volume clue, not
an accounting or authority input.
The accumulator uses the same enum-normalized, request/session-free routing key;
unit coverage proves duplicate/unknown values cannot manufacture another key.

The original degradation stays in DegradationReporter's open-event lifecycle, so
the existing guardian-pulse persistent-open review resurfaces a prolonged outage
without manufacturing a new timeout record per restart. The status fields provide
the drill-down and suppression count for that review.

## Decision points touched

| Decision point | Classification | Floor and authority |
|---|---|---|
| Admit an LLM authority probe while the breaker is open | `invariant` | The fixed persisted `open_until > now` policy is mechanical rate control, not semantic judgment. It may only suppress a probe; the route still fails open. |
| Reset the breaker after provider reachability | `invariant` | A completed provider response is the existing objective reachability signal. Response semantics are validated separately by the authority parser. |
| Stop/continue judgment | `judgment-candidate` | Unchanged: `UnjustifiedStopGate` remains the sole LLM authority over its enumerated rules and evidence floor. |

## Signal vs authority

The breaker is a deterministic resource/convergence floor, not a substitute
judgment authority. It never decides whether a stop is justified. While open it
withholds an expensive authority attempt and preserves the existing fail-open
`allow` outcome. Once the cooldown expires, the LLM authority is probed again.

## Multi-machine posture

The breaker is **machine-local by physical provider locality**: it describes the
health/latency of the CLI/provider process available on this machine. Replicating
it would let one machine's slow or unauthenticated door suppress a healthy door
elsewhere. Each machine's existing machine-local StopGateDb owns its row.

machine-local-justification: physical-credential-locality

No user-facing notice, URL, topic ownership, or transferable durable work is
introduced. Existing feedback forwarding remains unchanged.

## Migration and rollback

The table is additive (`CREATE TABLE IF NOT EXISTS`) and needs no backfill. An
existing database begins with a closed breaker, matching current behavior. The
rollback is code-only: older versions ignore the extra table. If persistence is
suspected, removing the wiring restores the previous in-memory behavior; no user
state repair or destructive migration is required.

The table is structurally bounded by the closed routing keyspace: each fingerprint
input is one of the four registered framework enums (or absent), and the ordered
failure tail is a no-duplicate permutation of that same four-value set. Release,
credential, path, environment, and request data cannot create keys. Retaining
prior route rows is intentional so A→B→A does not mint a new budget for A.

## Security and privacy

Only counts and timestamps are stored. Values are clamped on read so corrupt or
manually edited state cannot create negative counts or a non-finite deadline.
`open_until` is capped to one configured cooldown beyond `now` during hydration,
so a corrupt far-future timestamp cannot disable probes indefinitely. SQLite
inherits the existing StopGateDb `0600` file posture.

Epoch time is required across restarts; monotonic clocks cannot survive them.
Backward wall-clock jumps may lengthen a cooldown only up to the hydration clamp,
and forward jumps may admit an early probe. Both directions preserve fail-open
safety and the single-probe lease; neither can create an unbounded spawn loop.
Every live read clamps `open_until` and `probe_lease_until` to at most one
configured cooldown/lease beyond `max(now, updated_at)`, so a backward jump cannot
turn a valid row into an indefinite exclusion while the process remains alive.
Table-driven tests cover backward and forward jumps before hydration, while open,
while leased, and after successful reset.

### Why a fixed cooldown instead of a generic breaker/backoff queue

This is a synchronous two-second gate, so queuing or exponential retry would add
latency to the critical path. The atomic lease already ensures exactly one
half-open probe per cooldown across processes; jitter cannot reduce a herd below
one. Existing in-memory breaker libraries do not supply restart durability,
routing-key isolation, or SQLite lease ownership. A fixed five-minute cooldown
preserves current behavior while closing only the lifecycle-reset gap.
This is the standard persistent-circuit-breaker-with-half-open-lease pattern,
implemented locally because Instar already owns the synchronous StopGateDb and
must keep every acquisition inside its two-second hook budget; introducing a
second breaker/store abstraction would add adapters without changing semantics.

## Acceptance criteria

1. Two provider timeouts followed by a third failure open and persist the breaker.
2. A newly constructed gate over the same store immediately returns
   `breakerOpen`, invokes the provider zero times, and emits no new timeout kind.
   Repeating close/reopen at least five times under unchanged pressure preserves
   that zero-call result and does not grow the original timeout count.
3. After the persisted cooldown expires, exactly one half-open probe runs; failure
   re-opens durably, success resets durably. Concurrent callers and a simulated
   crash prove the bounded lease admits at most one probe and later self-releases.
4. Store failure never changes the existing fail-open route result.
5. `No Unbounded Loops` names restart-survival explicitly.
6. The self-action convergence guard reconstructs restart-sensitive controllers
   at multiple positions and under per-tick restart pressure, keeping their action
   count within the original K.
7. Unit tests cover state validation, hydration, failure/recovery, and persistence
   failure. Integration tests cover real SQLite close/reopen. E2E tests exercise
   route → timeout → restart/hydrate → instant fail-open without a provider call.
8. Typecheck, lint, standards coverage, class-closure, and the full unit,
   integration, and E2E CI tiers pass.

## Frontloaded Decisions

1. Persist the breaker in the already machine-local StopGateDb rather than adding
   a second state file or cross-machine record.
2. Preserve the fail-open direction and current timeout signal semantics.
3. Use the existing cooldown as the half-open recovery cadence.
4. Treat restart survival as a class invariant, enforced by the shared ratchet.
5. Key breaker state by routing configuration, excluding release version, so a
   real provider/config change probes immediately but a routine update does not.

## Open questions

*(none)*
