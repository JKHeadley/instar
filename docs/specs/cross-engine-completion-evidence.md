---
title: "Instrumented Cross-Engine Local Completion Evidence"
slug: "cross-engine-completion-evidence"
author: "Instar-codey"
status: draft
parent-spec: "docs/specs/correction-class-review-and-verify-before-done.md"
parent-principle: "Verify the State, Not Its Symbol"
characterization-report: "docs/specs/reports/cross-engine-completion-characterization.md"
eli16-overview: "cross-engine-completion-evidence.eli16.md"
lessons-engaged:
  - "Structure beats Willpower"
  - "Signal vs. Authority"
  - "Observation Needs Structure"
  - "No Silent Degradation to Brittle Fallback"
  - "Verify the State, Not Its Symbol"
  - "Framework-Agnostic — and Framework-Optimizing"
  - "Testing Integrity"
  - "Migration Parity"
  - "Cross-Machine Coherence"
  - "An Instar Agent Is Always a Multi-Machine Entity"
  - "No Unbounded Loops"
  - "No Deferrals"
  - "Maturation Path"
  - "Self-Heal Before Notify"
review-convergence: "2026-08-18T19:53:49.769Z"
review-iterations: 20
review-completed-at: "2026-08-18T19:53:49.769Z"
review-report: "docs/specs/reports/cross-engine-completion-evidence-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
cross-model-review-reason: "Final exact-body review returned SERIOUS ISSUES as architectural dissent and reported prompt truncation/context omission; gemini-cli:gemini-3.1-pro-preview degraded with reason:error."
single-run-completable: true
frontloaded-decisions: 22
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Instrumented Cross-Engine Local Completion Evidence

## Executive summary

The existing completion check reads Claude Code JSONL and intentionally no-ops for every other
engine. This design replaces that engine-specific transcript dependency with one Instar-owned
protocol for Claude Code, Codex CLI, Gemini CLI, pi, Grok Build, and Instar-native jobs.

The scope is deliberately narrow:

- only sessions launched through Instar's owned launcher/supervisor;
- only deterministic local action rows: `test-run`, `build-run`, execution-only
  `local-command`, and causally verified `file-write`;
- observe-only results: `verified | contradicted | unknown`;
- no LLM judge, no prose parser, no durable-external verification, no claim of complete sandbox
  confinement, and no arbitrary standalone CLI coverage.

Pushes, messages, cloud/database mutations, MCP/vendor effects, eventually consistent providers,
and hidden out-of-band side effects are `unsupported-for-verification` in this contract. They
require separate specs. This document contains no **action/provider** receipt listener, action
workflow engine, action outbox, provider callback, or broad-confinement design. Its separate
control plane deliberately does contain bounded durable publication coordinators for secure-update
metadata, freshness, emergency reduction, and activation receipts; those are control evidence,
not action-completion evidence, and are reviewed as custom closed state machines below.

An Instar-native `test-run` seed may validate the storage and rendering path in dark/dry-run mode,
but it can never create a user-visible positive verdict by itself. The first user-visible
observe-only generation requires global implementation parity: Instar-native, Claude Code, Codex
CLI, Gemini CLI, pi CLI, and Grok Build must each have a real qualified `test-run` fixture in the
same signed build generation. A host then admits only the engines actually enabled and runnable on
that host; it does not need every vendor credential or binary. Engine-specific optimizations may
expand later, but no host may consume a generation until the full build-supported cohort is
globally qualified.

## Architecture and build slices

```text
inbound adapter -> replay admission -> Instar launcher -> candidate/action seam -> local reducer -> canonical renderer
                                              |                    |
                                              +-> owned engine      +-> scrubbed pool read

CLASS registry + fixtures + calibration -> rollout authorization -> TUF control/freshness -> local overlay -> admission gate
```

These are four bounded planes: action evidence, inbound replay, CLASS/qualification, and control
distribution. They share only typed digests/states at the arrows above; no control-plane component
parses action prose or writes action evidence. They remain in one authority spec because a partial
positive activation is the defect being prevented, but implementation is hard-sequenced:

1. prospective CLASS gate plus Instar-native dark seed; no user-visible verdict;
2. local protocol/renderer and each engine adapter in dark mode; no consume path;
3. replay classification, pool projection, and all-engine qualification fixtures;
4. TUF control distribution, freshness, receipts, and atomic overlay, still dark;
5. only after every prior conformance artifact passes, signed observe admission.

The minimal shippable slice is step 1: it may merge and collect dark evidence but exposes no
positive claim, no external callback, and no new user-action block. Each later slice has an
independent compile-time registry assertion, real fixture corpus, migration/rollback test, and
fail-off integration test. `consumeEnabled` is structurally unreachable until step 5; stale
fixtures or a partially installed plane can only leave capture dark/off. The hard non-goals remain
provider effects, workflow/outbox behavior, standalone CLIs, hidden-side-effect confinement, and
verdict-based blocking.

Keeping these planes in one authority spec is an explicit decision, not an implementation demand
for one component. The local evidence library, engine adapters, qualification CI, TUF publisher,
and three bounded read/signing services are separate packages/processes with the digest-only seams
shown above. Splitting their positive-activation contracts into independently approvable specs
would reintroduce the exact partial-authority state this design forbids: a local renderer could
claim evidence before cohort qualification, replay admission, or current rollback control existed.
Dark slices remain independently shippable; only the user-visible positive transition is atomic.

Observe-only does not make the control plane optional. The display is non-blocking, but a stale,
partially deployed, or rollback-blind positive label would still be false authority presented to
the user. The threshold emergency and positive-health roles therefore govern only whether a
previously reviewed global generation may continue to display; they never judge an action,
increase a clause verdict, or turn `unknown` into `verified`. This is the minimum role of those
services, and it is why simpler unsigned per-engine stream proof is insufficient for the shared
agent-general surface.

Already captured local facts remain available in the private audit store when control is stale;
only the canonical user-facing verdict block is suppressed. Otherwise an old client could keep
showing a locally true “test passed” label after the schema that defined the candidate set was
withdrawn, while a newly routed turn on another engine omitted the same action entirely. Raw tool
output may still appear as untrusted turn content, but neither it nor an engine name is completion
authority without the current shared contract.

Normative state-machine quick reference:

| Machine | States | Only positive-authority transition | Any missing/conflicting/stale input |
|---|---|---|---|
| local mode | `off-unverified | dark-parity | observe-only-parity` | local ceiling + qualified generation + current command/group + full command parent + freshness/TUF/health/lease proofs → observe | off; explicitly configured capture may remain dark |
| action turn | `open | candidate-frozen | terminal` | launcher-owned exact candidate set + one matching close → terminal clause rendering | affected clauses unknown or freeform; no action retry |
| action evidence | `intent | result | terminal revision 1 | terminal revision 2` | exact causal sources satisfy the closed clause predicate | clause unknown; explicit matching disproof alone contradicts |
| inbound replay | `ineligible | admitted` | authenticated ordered cursor or unified acknowledged-id proof before launch | pre-v2 action behavior with the whole close unverified |
| cohort rollout | `hold | authorized` | every canonical engine globally qualified plus local enabled/runnable row admitted | hold; no per-engine positive record |
| publication | `prepared → command-signed → package → targets → snapshot → active` | final fenced freshness CAS over exact read-back bytes | resume exact intent, strand/conflict off, or emergency descendant; no sibling |
| timestamp | `prepared → signed → published → freshness-committed` | version+health read-back then next freshness epoch CAS | insufficient-validity/write-uncertain/expired; consume off |
| emergency floor | `genesis | rollback-pending | satisfied` | none—pending only reduces; signed H2 atomically satisfies the replay floor | pending/off or rejected floor; never raises authority |
| active census | `reserved | active | releasing` | fenced control activation changes exact included leaves to active, total ≤64 | target dark/off; uncertain leases stay charged |

The detailed schemas, brakes, crash points, and fixtures below are normative refinements of this
table; the table never authorizes a transition by itself.

Common observe activation, in normative order:

1. Qualification CI emits the required content-addressed current-run fixture/result artifacts only
   after every canonical engine's positive and negative real fixture passes; otherwise no
   observe-authorizing input exists. The enrolled ring coordinator separately machine-signs the
   applicable closed aggregate variant: pre-command enrollment for bootstrap or post-command
   receipts for a later rung.
2. The protected release pipeline revalidates those artifacts, is the sole signer of the exact
   rollout generation, and accepts only the complete applicable conflict-free aggregate set:
   pre-command enrollment aggregates for initial activation, or exact prior-command/window receipt
   aggregates for a later rung.
3. Under the shared fence, the initial publication prepare CAS reserves or replaces the complete
   target set in the private ≤64-target census and stores the exact unsigned command and version
   allocations. The same candidate is then signed and published package → targets → snapshot, with
   exact-byte read-back at each phase; any ambiguous write keeps consume off and freezes that same
   candidate pending deterministic not-started/absent/exact-present/conflict classification and
   recovery.
4. The linked timestamp/freshness CAS is the sole activation point: it changes those reserved
   leaves to active and commits the exact command head, census root, TUF versions, and lease set.
   Any missing pool/ring input or noncontiguous promotion keeps every affected target dark.
5. The independent emergency endpoint returns the exact current positive-health body and any
   emergency floor; the freshness endpoint separately binds those digests, the TUF timestamp,
   command, census root, and expiry into one current response.
6. A targeted host independently verifies TUF, emergency/health bodies, freshness, its census
   inclusion, local requested-mode ceiling, engine runnability, stream ownership, and admitted row.
7. Only then may the launcher render the canonical clause block. Any rejection at steps 1–6 keeps
   private captured facts non-authoritative and emits no positive verdict block.

Emergency-off, in normative order:

1. The reduction-only 2-of-3 role freezes the shared publication fence and CASes a strictly newer
   `rollback-pending` floor against the exact active head; failure to establish the floor grants no
   new authority. If quorum fails, the marker expires, or the floor CAS fails, recovery may restore
   or rebind the prior fence mode only after proving the frozen publication row and head are
   byte-unchanged; conflict or an unclassifiable state remains frozen/off.
2. The reserved non-borrowable lane signs and publishes the exact global off descendant, with TUF
   metadata read back under the same immutable intent; no sibling or positive command is permitted.
3. Activation atomically advances H2 and satisfies the floor only after the signed off command is
   current. Hosts independently verify the newer floor/body and reduce to off; missing or
   disagreeing inputs also fail off. Old census leases remain charged until expiry or a verified
   signed off receipt releases them in a higher census generation.
4. Restoration requires a later separately qualified authority-increase generation above H2; it
   never revives the stranded pre-emergency candidate.

## Terms and closed states

- **Authoring engine:** the CLI/job engine running the session.
- **Instrumented session:** a session whose launcher owns the turn binding, mediated action seam,
  child process, final response sink, and turn close.
- **Mediated action:** an action invoked through the registered supervisor seam before any side
  effect; unmediated work is outside this spec.
- **Turn binding:** a signed opaque identity joining one logical session turn to its actions and
  evidence without using timestamps or text.
- **Action row:** one engine + action-kind + schema-version verification contract.
- **Canonical close:** the launcher-controlled final response assembled from the complete mediated
  action candidate set.
- **Freeform close:** untrusted engine prose, visibly unverified.
- **Pool:** this agent's authenticated enrolled machines. It is not public or cross-tenant.
- **Projection:** the bounded scrubbed read model stored by `ClaimObservationRecorder`.
- **Sentinel:** a closed candidate entry representing unsupported, unknown, or over-limit work
  without pretending it is a supported action.
- **CAS:** compare-and-swap; a write succeeds only from the expected prior revision.
- **Rollout rung:** one ordered dark, dry-run, or observe-only activation step.
- **Bounded V1 cohort:** the globally admitted set of at most 64 active observe targets across all
  pools and rings. Any later unbounded or larger fleet rollout requires a capacity spec.
- **Fleet ring:** the production-labelled rollout ring within that bounded V1 cohort; it does not
  mean every installation or an unbounded deployment.
- **Freshness:** a signed statement that exact already-published control bytes remain current; it
  is not action recency or provider settlement.
- **Positive authority:** permission to display the reviewed observe-only protocol and coverage
  label; it never supplies or upgrades an action verdict.

Standard names retain their standard meanings: **TUF timestamp** is TUF 1.0 timestamp metadata,
**CAS** is compare-and-swap, and **lease** is a bounded expiring allocation. Instar-local terms are
the bold entries above: **freshness** is the separate exact-byte liveness statement, **floor** is a
monotonic reduction boundary, **generation** is one signed cohort contract, **census** is the
private active-lease set, and **projection** is the scrubbed recorder read model.

End-to-end happy path and failure direction:

| Phase | Owner | Durable/signed output | Failure direction |
|---|---|---|---|
| launch | supervisor | host/engine/build/turn binding and current stream proof | visibly unverified freeform |
| mediated action | launcher + isolated producer | pre-action candidate, ordinal, intent/result, authenticated source | candidate retained as `unknown`; over-limit action rejected |
| close | launcher | terminal manifest, exact candidate-set digest, signed bounded envelope | invalid/missing close; no positive block |
| local projection | recorder worker | immutable head/revisions under fixed quotas | local clause `unknown`; no retry/eviction |
| pool read | serving host + origin signatures | scrubbed heads/mappings and partial/conflict metadata | remote `unknown`; local authority unchanged |
| coverage/rollout | deterministic registry + signed generation and ring overlay | global engine qualification plus current targeted local activation/host-row admission | dark/off; no legacy fallback |

Operator-only diagnostics distinguish `captured-display-authorized`,
`captured-display-held-control`, `captured-display-held-row`, and `no-captured-evidence`. These
closed values are derived from the private audit store plus the exact failed admission predicate,
appear only in Process Health/audit, and never change the user-facing verdict or coverage label.
Thus availability collapse is debuggable without presenting locally true but contract-stale facts
as current completion authority.

Their derivation is total and ordered: no accepted private evidence → `no-captured-evidence`;
otherwise all admission predicates true → `captured-display-authorized`; otherwise any global
generation/TUF/freshness/health/emergency/census predicate false →
`captured-display-held-control`; otherwise → `captured-display-held-row` for a local engine, stream,
row, candidate, or clause failure. Audit may list the bounded failed predicate ids, but this first
matching value is the only summary state.

No implementation, config, metric, or Process Health view may invent composite state shorthand:

| Object | Field | Closed values |
|---|---|---|
| engine build | `support` | `absent | build-supported` |
| cohort engine | `enablement` | `disabled | enabled` |
| action row | `disposition` | `uncharacterized | eligible | unsupported-for-verification` |
| host canary | `runnability` | `never-observed | runnable-fresh | unrunnable-fresh | stale` |
| control seam | `controlAvailability` | `current | unavailable | stale | failed` |
| stream proof | `streamOwnership` | `missing | current | stale | failed` |
| evidence source | `availability` | `complete | partial | unavailable | conflicted` |
| turn close | `mode` | `canonical | freeform | invalid | missing` |
| declared clause | `verdict` | `verified | contradicted | unknown` |
| rollout | `mode` | `off | dark | dry-run | observe-only` |
| engine health | `coverage` | `observed-mediated-local-action-verification | partial-observed-mediated-local-verification | not-verified` |

`instrumentedAdmitted` is derived, never persisted:

```text
enablement=enabled
+ runnability=runnable-fresh
+ controlAvailability=current
+ streamOwnership=current
+ disposition=eligible
+ localTupleAdmitted=true for the exact canonical qualification key
```

`globalEngineQualified` is separate: the signed build-generation artifact has an executed positive
and negative corpus for every canonical engine and passes the CLASS ratchet below. An absent or
disabled engine on one physical host is not a local coverage failure; an enabled/observed engine on
that host with no eligible row is. A local row cannot borrow another host's runnability or stream
proof, and a host cannot activate against a globally incomplete generation.

Every qualification/admission gate uses one canonical
`CompletionEvidenceQualificationTupleKeyV1`:

```text
engine id + exact engine build id + executable-content SHA-256 + OS/runtime class
+ launcher/control-seam build SHA-256 + action-row kind/schema version + renderer generation
+ reviewed evidence-component-bundle SHA-256
```

The evidence-component bundle is a canonical manifest of the exact runtime verifier,
isolated report producer/CommandWitness/native adapter, report parser, canonical codec,
schema/registry implementation, and the qualification fixture runner/source digests. The host
derives its bundle digest from object-bound local component bytes plus the reviewed fixture entries;
a missing, changed, or path-only component cannot use the manifest digest.

The signed rollout generation contains a sorted set of at most 64 such keys, at most 256 canonical
bytes/key and 16 KiB total **including collection framing and reference flags**, and marks exactly one or more executed real-fixture keys as
`reference=true` for each canonical engine. `globalEngineQualified(engine)` means the current set
contains at least one passing reference key for that engine and its engine-level CLASS artifacts
pass; the global cohort gate means this is true for every canonical engine id.
`localTupleAdmitted` separately means the exact key derived from the launched local tuple is present
and passing in that same set, plus the host-local runnability/stream/control predicates above. No
engine name, build family, OS family, or reference key can stand in for a different exact tuple.
A new executable, adapter build, OS/runtime class, row schema, or renderer generation therefore
remains dark/off until its exact key is added to a later reviewed generation; it does not make an
older exact tuple borrow its proof. Count/byte N/N+1, duplicate-key, conflicting-reference,
missing-engine-reference, and local-key-near-match fixtures reject before signing or admission.
Component fixtures cover swap-between-qualification-and-run, producer/verifier/parser/codec/schema
near-match, plugin/helper replacement, and missing component; every mismatch stays dark/off.
One host may register, measure, or admit at most 16 exact qualification tuple keys across all
engines. A 17th key remains unmeasured and dark/off before sample allocation; it cannot displace or
merge an existing key. This is a separate enforced limit from the proof-key cap, even when their
identities happen to coincide. Cross-engine/key 1/16/17 fixtures cover the boundary.

Coverage is deterministic:

| Label | Derivation |
|---|---|
| `observed-mediated-local-action-verification` | global engine generation/census is current; the authenticated local manifest contains every registered or observed mediated row for engines enabled/observed on this host; every such row has `instrumentedAdmitted=true`; the denominator is available; and current instrumented-turn coverage is ≥95% |
| `partial-observed-mediated-local-verification` | observe-only and the global generation/census/denominator are current and at least one local row is admitted, but a locally enabled/observed row is omitted/uncharacterized/unsupported/ineligible or coverage is <95% |
| `not-verified` | observe-only is inactive; the global generation/census or local denominator is unavailable; or no scoped local row is instrumented-admitted |

An unknown clause does not change engine coverage. Coverage does not change a clause verdict.
The manifest is the union of the reviewed registry and dark observed candidate inventory, including
unsupported and unknown sentinels. It is bound to the signed rollout-generation digest and shrink-only: removing a row
requires a reviewed disable/removal migration in the same change. A newly observed omitted kind
immediately forces `partial-observed-mediated-local-verification`; rollout config cannot select a favorable subset.

## CLASS review

### Missing standard

**An agent-general mechanism MUST carry a characterized row for every build-supported engine.**
Each admitted row names its canonical evidence contract, instrumented primary, fault-separated
deterministic verifier or proven native redundancy, real fixture, and failure tests. Missing
coverage is an explicit row disposition and clause `unknown`, never a silent no-op.

The rule applies at the user-visible activation boundary, not only in the registry. Dark seed work
may validate shared machinery, but no positive evidence block or positive engine-coverage label may
activate until every build-supported engine qualifies in the same reviewed generation.
This parity cost is deliberate: the defect being repaired is an agent-general safety mechanism
whose positive authority silently excluded other engines. Shipping another engine-subset positive
surface would preserve that class of failure. While the cohort is incomplete, the launcher may
show only the fixed non-positive status `Completion evidence unavailable: global engine cohort not
yet qualified`; it cannot show an action verdict or coverage label. Dark Process Health remains
available for implementers.

An explicitly labeled per-engine positive surface was considered and rejected for this feature.
Instar may route the same user/task across engines between turns; showing “verified” on one engine
while the agent-general completion mechanism is absent on another recreates the original class bug
behind a smaller label and makes routing affect safety affordance. The delivery cost—the least-ready
build-supported engine can hold positive activation—is accepted. A future engine-product-specific
feature may choose a separate UI/feature id and contract, but it must never inherit this mechanism's
agent-general name, badge, coverage denominator, or rollout generation.

For example, turn A on Claude could label a mediated test “verified for this turn” while turn B,
routed automatically to Gemini, silently omitted its unregistered test and showed no comparable
block; a user would see routing-dependent assurance for the same agent task. Likewise, a stale
Codex adapter could verify only exit code while the current cohort contract also requires the
artifact predicate. Naming the engine does not repair those asymmetric candidate sets. A truly
engine-product-specific surface remains possible only as the separate feature described above.

### Development-process gap

The parent review accepted a declared Claude-only no-op as complete. It did not require:

- an engine/action coverage matrix;
- real fixtures per engine;
- a CI ratchet tying build-supported engines to rows and benchmark cases;
- an activation ratchet refusing a user-visible generation unless every build-supported engine is
  represented by a real admitted row;
- a fault-separated redundancy test;
- proof that output after a completion declaration cannot reach the user.

The process fix is a coverage-preserving registry plus CI that fails when a build-supported engine
lacks a row or when a user-visible generation omits an engine. Rows may remain `uncharacterized`
in dark/dry-run, but cohort-wide observe-only activation requires at least one `eligible`
reference `test-run` fixture for every build-supported engine in the signed global generation;
runtime stream/control proof remains host-local for engines enabled on that host.

This is also a global development-process upgrade, not a completion-only checklist. Every future
agent-general mechanism must add `upgrades/framework-coverage/<slug>.json`, generated from the
canonical `SUPPORTED_FRAMEWORKS`/`IntelligenceFramework` registry plus any named native engine.
The artifact contains one row per engine with a positive-control fixture, failure fixture, and
reviewed evidence reference. Its closed schema includes `schemaVersion`, `mechanismSlug`,
`mechanismSourceSha256`, `registrySha256`, `engine`, `engineBuildDigest`, `platformTuple`,
`runnerSha256`, executable positive/negative fixture ids, expected outcomes, observed outcomes,
`runId`, `observedAt`, and content-addressed result evidence. The generated engine rows must match
the registry exactly; source/runner/build hashes must match the checked-out commit; and run evidence
must be produced by the current CI run, not copied from a prior commit.

`assertFrameworkGenerality` executes every referenced fixture through the real mechanism, validates
the observed outcomes and hashes, and refuses an agent-general claim when the artifact is absent,
hand-enumerated, stale, contains `not-applicable`, or cites a non-executed/no-op fixture. CI injects
a synthetic framework into the canonical union and proves that an unchanged artifact fails; it
also substitutes a fixture that returns success without traversing the mechanism and proves the
artifact fails. This
general ratchet closes the process gap that allowed the completion checker—and could allow any
other off-lifecycle feature—to escape the existing launch/inject-only parity guard.

Applicability is structural, not an author checkbox. The same PR adds a typed
`AgentMechanismRegistry` and generated `upgrades/framework-mechanisms.json` inventory. Every
sanctioned engine/model-driven side effect or user-visible-output chokepoint—action router, engine
launcher, hooks, message send adapters, provider dispatch, autonomous/background job execution,
and completion renderer—requires a branded `MechanismContext` minted only for a compiler-known
registry id. Dynamic/generated handlers must resolve to that id before invocation. The closed
`MECHANISM_CHOKEPOINTS` and mechanism-id unions are compiler-exhaustive; adding one without its
other half fails typecheck/CI, and runtime entry assertions reject missing/unknown tokens.

The registry is the source population. Every row defaults to `agent-general` and fixes candidate
id, source/callsite hashes, entrypoint/side-effect classes, `general | engine-scoped`, exact scoped
engines, and independent-review evidence. A separate AST/call-graph detector walks direct calls,
dynamic imports, registration tables, generated handlers, and changed transitive imports to find
attempted chokepoint bypasses; its output is compared with the independent registry/chokepoint
union. A direct sanctioned side effect without `MechanismContext`, a registry/inventory mismatch,
or a scoped row without a compiler/runtime negative fixture proving omitted engines cannot reach it
fails CI. The synthetic-engine/no-op controls run against the registry population. The certified
claim is narrow: every registered sanctioned mechanism added or modified after gate activation is
classified and covered; arbitrary unsanctioned code and untouched legacy candidates remain
unverified until migrated. `assertFrameworkGenerality` never consumes a self-authored
“agent-general” claim.

The implementation PR also creates `upgrades/framework-coverage/backlog.json` from a full baseline
scan. Every historical candidate has source digest, state `covered | legacy-unverified`, owner
`framework-generality`, issue/artifact reference, discovered time, and a due date no later than
2026-11-16. The completion mechanism ships `covered`; every new or modified candidate must be
covered immediately. `assertFrameworkGenerality` refreshes this backlog on every relevant PR and
protected release, refuses silent disappearance, and makes overdue entries a release-gate failure.
Until the backlog reaches zero, a bounded weekly CI scan independently re-runs the full baseline:
one single-flight attempt keyed by ISO week and source commit, maximum 60 seconds and 256 MiB, no
in-run retry, a breaker open until the next weekly bucket after any failure, and immutable scrubbed
result metadata retained for 90 days. A miss, failure, or result older than eight days sets
`historicalCoverage=unknown` and fails the next relevant PR/protected release; those gates are the
stale-job detector. Every scan also idempotently upserts exactly one `FrameworkIssueLedger` action,
keyed `framework-generality:historical-backlog`, with owner, remaining-set digest, due date, and the
next bounded 25-row implementation slice; a successful remediation PR advances or closes that same
row rather than creating another.

At 14 days before the due date, an unresolved row is `recoverable` and passes through the shared
`SelfHealGate` with this machine-readable declaration:

- `class`: recoverable
- `remediation-actions`: regenerate mechanically provable coverage artifacts for the next 25-row
  slice; run the full assertion corpus; idempotently open or update one draft remediation PR
- `max-attempts`: 1
- `max-wall-clock`: 60s
- `backoff`: next weekly bucket
- `dedupe-key`: remaining-set-digest + due-date
- `breaker`: 7d; three heals of the same remaining-set digest within 30d auto-reclassify it to
  critical and notify immediately while the bounded heal proceeds concurrently
- `max-notification-latency`: 60s
- `audit-location`: `FrameworkIssueLedger.audit`, scrubbed metadata only, retained 90d

The 60-second values must also be no greater than the live registry ceiling; a missing or lower
ceiling fails closed to the lower/immediate backstop. The branch and draft PR use the dedupe key as
their idempotency guard. Validation failure is compensated by closing only that draft and restoring
the prior ledger revision; generated artifacts never merge outside the protected branch gate.
The draft has durable reviewer `framework-generality-reviewer`, merge
owner `protected-release-maintainer`, and a two-business-day review SLA. `repair-proposed` is not a
successful heal: only a protected-branch scan whose remaining-set digest shrank under passing
fixtures is `repaired`. At the next weekly scan—and no later than seven days before the due date—a
still-unmerged draft exhausts the heal and opens attention even when green. Every detection/attempt/
result is scrubbed into `FrameworkIssueLedger.audit` for 90 days. Only after the attempt fails/
exhausts, including a returned wall-clock timeout, does one deduped Attention Queue item open.
Independently, if cancellation/timeout return is still stuck at the 60-second notification ceiling,
the same item opens with state `remediation-still-running`, not a false failure verdict; this is the
standard's latency backstop, not first-detection escalation. A deadline breach remains recoverable for this gate but cannot be
re-dated automatically; after the bounded proposal attempt, any nonzero protected-branch backlog
is exhaustion and escalates regardless of draft health. The schedule and attention item are
removed/resolved by the same protected release that records zero remaining backlog, so the
watcher cannot become immortal. The global gate
may claim prospective enforcement at ship, but not full historical coverage until this durable
backlog reaches zero.

## Characterization conclusion

The requested LLM pathway characterization was completed and is retained in
`docs/specs/reports/cross-engine-completion-characterization.md`.

On 2026-08-18, authenticated freshness reads returned explicit degraded states:

- `GET /doorways`: 503, no Instar-source manifest resolvable from the configured project directory;
- `GET /decision-quality?sinceHours=720`: 503, uniform provenance seam dark;
- `GET /benchmark-divergence`: 503, detector dark.

The most recent direct probes (2026-07-24) found Claude Code/headless, Codex, and pi runnable; the
Gemini shim lacked a selected asdf version. Fresh review detection found Codex and Gemini review
CLIs, but that is not completion-specific route quality. The closest `completion-judge` benchmark showed strong research candidates, but its
inputs are transcript-shaped rather than the canonical envelope in this design. The durable
prediction mirror contains `tone-gate`, not completion-evidence judgments.

Therefore no model/door route is admitted. V1 is deterministic. Measured model routes remain
research only and have no runtime registry row, fallback authority, or activation implied here.

## Foundation transition and single authority

The existing foundation is explicit: `TurnEvidence` tails Claude Code activity,
`CompletionClaimVerifier`/`ClaimClauseArbiter` reason over completion prose, and
`ClaimObservationRecorder` persists a metadata-only JSONL projection. This design does not place a
second completion authority beside that path.

`completionEvidence.requestedMode` is a closed, migration-owned request:

| Mode | Runtime authority |
|---|---|
| `legacy` | pre-update descriptor only; invalid on a v2-capable process and derives `off-unverified` |
| `dark-parity` | canonical envelopes run as non-authoritative shadow evidence; user output is visibly unverified and legacy has no positive authority |
| `observe-only-parity` | canonical envelope/verifier/renderer is the sole completion-evidence authority for a locally admitted engine |
| `off-unverified` | no positive completion verdict; all engine prose is visibly unverified |

The runtime derives one effective state; kill switches always reduce authority and never restore
legacy:

| Inputs | Effective state |
|---|---|
| `captureEnabled=false` or requested `off-unverified|legacy` | `off-unverified` |
| capture true, `consumeEnabled=false` | `dark-parity` when requested dark/observe; otherwise off |
| capture+consume true, requested `dark-parity` | `dark-parity` |
| capture+consume true, requested `observe-only-parity`, current valid rollout generation/ring overlay/independent freshness response, and locally admitted engine/row | `observe-only-parity` |
| requested observe with missing/conflicted/stale generation, ineligible local row, worker/custody failure, or invalid combination | `off-unverified` for the affected turn/host; no legacy fallback |

Fresh and migrated existing agents default to requested off with both switches false. Test/dev rungs
set capture true and consume false. Local deployment config is a ceiling: it alone sets
`requestedMode` and the two switches. A rollout record never mutates them; it supplies the separate
maximum authorized generation/mode, while a signed ring-promotion overlay selects a state no higher
than either source. Capture-only dark may run without a promotion when the local maturation registry
explicitly requests dark; it has no positive authority and is the bootstrap that produces rollout
qualification evidence. Consume is impossible without both a current rollout authorization and
current promotion overlay. Peer settings never
grant local authority: the current serving process derives its own state, and pool rows are data,
not configuration. Tests exhaust the Cartesian product, mixed-peer states, migration/downgrade,
worker failure, and restart.

The protected deployment pipeline is the only actor that signs an activation overlay. After a
rollout record authorizes observe, it emits a signed discriminated-union
`CompletionEvidencePromotionV1`. Both variants contain rollout generation/digest, globally
monotonic `commandEpoch`, `previousPromotionDigest`, exact current checkpoint epoch, exact
active-census generation/root, change class `refresh-only | authority-increase |
authority-reduction`, issued time, expiry no later than eight days, and rollback tuple.
The `pool-targeted` variant additionally
requires one fresh command salt and a canonical sorted array of 1–64 `PoolTargetGroupV1` values;
each group requires ring `dev | fleet-canary | fleet`, exact desired
`{requestedMode,captureEnabled,consumeEnabled}`, qualification-window digest, one fixed 32-byte
pool-scope token, its exact pool-continuity-key generation, and a sorted array of target descriptors.
Each descriptor contains target token, exact prior-config digest, and lease expiry; the command-wide
target total is at most 64 and each active lease appears exactly once. It forbids emergency-only
fields. The `global-emergency-off` variant requires change class `authority-reduction` and the desired tuple to be off,
omits and forbids command salt, pool groups, pool/target tokens, continuity-key generations, and
lease proofs, and requires the rollback tuple. Let
`poolCommitment=HMAC-SHA256(poolContinuityKey,
"instar/ce/pool-commitment/v1" || poolContinuityKeyGeneration ||
authenticatedPoolCensusRoot || membershipGeneration)`;
`poolScopeToken=SHA256("instar/ce/pool-target/v1" || commandSalt || poolCommitment)`. A target token is
`SHA256("instar/ce/target/v1" || commandSalt ||
poolCommitment || SHA256(hostEnrollmentNonce || enrolledMachinePublicKey))`; both are unlinkable across
commands and reveal no machine/agent id. One ordinary command is a complete snapshot of every
currently admitted lease across every pool and ring, so renewal or membership change refreshes all
active groups in one global epoch rather than consuming one epoch per pool or ring. The canonical
ordinary command is at most 16 KiB: fixed fields are capped at 768 bytes, 64 group headers/tokens/
key generations/ring/desired/window digests at 96 bytes each, 64 target descriptors at 80 bytes
each, and CBOR/signature slack at 4,352 bytes; emergency-off is at most 4 KiB.
`promotionDigest` is the SHA-256 of the canonical unsigned promotion payload; the Ed25519 signature
is an envelope over that digest-bound payload and is not part of the digest, so the prepared
candidate's exact chain identity exists before a signer call. Each target host verifies
authorization, exact recomputed local pool-scope and target tokens, ring membership, current active
lease inclusion, current local admission, exact current rollout/checkpoint,
contiguous command epoch/digest, and prior-config digest before accepting it. The
ladder is: dev dark → dev observe; bounded fleet-canary off/dark → observe; fleet off → observe.
`refresh-only` must preserve the exact stable active-lease set, every ring/desired tuple, rollout
generation, prior-config digest, qualification-window digest, authority epoch, and original window
start; it may change only command salt/tokens, continuity-key generation, lease expiry, and
transport metadata. It cannot add a host or raise capture, consume, mode, ring, or authorization.
`authority-increase` is the conservative class whenever any group adds a lease or raises any of
those fields, even if another group reduces authority; it starts a new authority epoch/window.
`authority-reduction` contains only removals or lowered tuples and may run immediately. Each ring
must finish its wall-clock window before the next `authority-increase`; refresh-only renewal during
that window preserves its original start and evidence. Integrity/security failure
requires a later, higher-epoch signed rollback command to off; measurement degradation may use a
higher-epoch command that lowers consume to dark while capture continues. A rollback is never a
mutable field on an earlier promotion. A rollout record alone never raises consume, and a promotion
cannot exceed its record's authorized mode/generation.
`global-emergency-off` reduces every host regardless of pool. Each ordinary epoch supersedes the
prior ordinary snapshot for every active pool/ring group; a newly added pool cannot omit an
already active lease. Each host verifies the complete global head and applies the newest non-expired
ordinary command containing its recomputed pool and target tokens, unless a newer global emergency
off exists. Two ordinary epochs per rolling 24 hours can therefore renew the full 64-host/64-pool
census at once. The first slot is the scheduled all-host refresh; the second coalesces all eligible
membership/authority changes. A third change remains dark or charged in its prior state and joins
the next available epoch; it never bypasses the rate cap. An eight-day 64-host/64-pool soak with a
daily refresh, one coalesced change epoch, a rejected third change, and N/N+1 proves issuance
headroom, expiry, suffix, and batching behavior.
Control targeting accepts only the newest non-revoked continuity-key generation named by the
freshness floor. Older overlapping generations may verify retained evidence only; they cannot
derive a pool token, enroll, renew, receive a command, or produce an activation receipt.

The carrier is a content-addressed, immutable `@instar/completion-evidence-control` npm release
bundle published by the existing protected release pipeline. The authoritative locator is a TUF
1.0 repository at `updates.instar.dev`: the installed release pins threshold root metadata; a
60-minute timestamp names snapshot version; snapshot names the standard top-level `targets.json`;
its `completion-evidence-control` entry fixes npm package version, SHA-256, length, bundle head,
and census root, while separate `completion-evidence-freshness-key` and
`completion-evidence-emergency-off-key`, `completion-evidence-positive-health-key`, and
`completion-evidence-pool-membership-authority-key` entries carry
the bounded current public-key records for those roles. Root directly authorizes the top-level targets role. V1 uses
no delegated roles; pool/ring applicability stays inside the separately signed command.
Consistent snapshots and persisted maximum metadata versions provide standard rollback/freeze/key-
rotation protection. The npm dist-tag is an untrusted discovery hint and is never accepted as the
current head. A new dedicated reader (not `UpdateChecker`'s cached `npm view` fallback) fetches that
TUF chain and then the exact target with fixed-host, no-credential HTTPS;
it accepts no redirect away from `updates.instar.dev` or `registry.npmjs.org`, clamps each connect+body time to five seconds,
streams with reject-before-allocation, and accepts at most 1,152 KiB. A canonical bundle contains the
current signed `CompletionEvidenceReleaseFloorV1`, promotion head, live suffix, and checkpoint:
64 ordinary commands at most 16 KiB each, two non-borrowable emergency-disable commands at
most 4 KiB each, at most two ordinary commands per rolling 24 hours, and 30-day retention. Thus the
command suffix is at most 1,032 KiB and the fixed floor/checkpoint/package allowance is at most 76
KiB, for a 1,108 KiB canonical bundle and 1,152 KiB transport ceiling. Immutable package versions are
the audit history; the current TUF top-level target names the current head. Saturation, compaction failure, loss of
the current head, a stale/older TUF response, or inability to durably apply state derives
`off-unverified` before any command is used. Emergency rollback may use a reserved slot, but safety
does not depend on that write succeeding. Recovery from an invalid active bundle requires a newer
valid bundle; an in-progress publication instead resumes its exact prepared candidate. Signed
history is never evicted to make room.

`CompletionEvidenceReleaseFloorV1` carries monotonic `minimumCheckpointEpoch`,
`minimumRolloutGeneration`, `minimumPromotionEpoch`, `rollbackEpoch`, minimum operator/security
review-role and emergency-off-role generations, and the checkpoint/rollout/promotion/rollback digests. Readers compare the
numeric tuple componentwise and then require digest equality at the named epochs; a digest is never
treated as orderable. `minimumPromotionEpoch` and its digest name the global command-chain head,
while the freshness response separately names the newest non-expired ordinary snapshot applicable
to the requesting pool and any later global emergency-off command. A host proves both their
membership in the global suffix and their equality to those response fields. Because an ordinary
snapshot repeats every active pool group, activity in pool B cannot silently drop pool A.

The public bundle is metadata-only. It contains command-scoped target tokens, fixed digests,
counts/times/enums, and role-pseudonymous key ids—never raw machine/agent/tenant ids, names, URLs,
incident text, evidence bodies, or stable cross-command target identifiers. Fork artifacts carry
only an incident-evidence digest; the evidence itself remains in the private release audit store.
Canonical-schema allowlisting, correlation tests across 10,000 generated commands, and a raw-id/
text secret scanner fail publication. No token or digest from one Instar agent is accepted in
another agent's command because each host recomputes both pool and target membership from its
authenticated current pool census, unpredictable local enrollment nonce, and enrolled machine key; token
copying cannot create a match in a different pool/installation.

Migration and every zero-state/reimage event generate a random 32-byte host enrollment nonce in an
owner-only, no-follow, backup-excluded 256-byte atomic file. The host publishes only a
512-byte machine-signed `CompletionEvidenceEnrollmentRequestV1` (private pool commitment,
nonce+machine-key commitment, ring, build,
machine-key generation, pool-continuity-key generation) into the private evidence database; its commitment binds the nonce to the
enrolled machine public key. Ring-qualification CI passes its digest and bound commitment to the
protected pipeline through the bounded aggregate below. Duplicate commitments or one commitment
under two machine keys conflict and hold the census off. A host with a new nonce remains capture-only dark
until a later command contains its derived target token, so no pre-reimage promotion can activate
it. Nonce collision, backup restore, copied-state, wrong-product, and old-command fixtures fail off.

Npm supplies immutable commands, not freshness. A separate minimal freshness foundation at
`POST https://updates.instar.dev/v1/completion-evidence/head` accepts a 32-byte random request
nonce, ring, pool-scope token, command-scoped target token, and installed-build digest (request ≤320
bytes) and returns a no-store, ≤2 KiB
`CompletionEvidenceFreshnessV1`: echoed nonce, ring, pool-scope token, monotonic freshness epoch,
current floor/global-head/rollback digests; comparable minimum checkpoint/rollout,
global-promotion-head, latest-applicable-pool-promotion, and global-emergency-rollback epochs;
exact installed-build digest; current census digest/generation/active-lease root; minimum
operator/security-review and emergency-off role generations; current positive-health role
generation/epoch, digest, and expiry; server
time, minimum pool-continuity-key generation, TUF root/timestamp/snapshot/targets versions,
expiry no later than 60 minutes, and signature by the independent
`completion-evidence-freshness-v1` key. The TUF timestamp key is authorized by threshold root and
signs only standard TUF timestamp metadata. The distinct freshness public key is distributed as a
threshold-authorized custom target and signs only `instar/ce/freshness/v1` responses. These keys
have different principals/custody and either alone is insufficient. The
service stores one current global control head, ring applicability indexes, and the bounded 64-entry
current census in a strongly consistent CAS table; for a current or previous pool token it returns
the latest applicable pool/ring group in that head while retaining the global head. Only a request
carrying the current pool and target tokens
receives the active-lease leaf/proof and can authorize consume. A previous-token request receives a
signed transition-only response naming the newer TUF/head versions with no lease proof; it disables
consume and triggers acquisition but cannot extend the old command. The release pipeline commits a higher
rollback floor there before publishing the rollback bundle. It stores no request/host identifiers.
It must sustain at least 256 requests/hour/ring with a 64-request minute burst and p99 ≤100 ms;
overload returns `429` with no cacheable body, which clients treat as freshness failure and back off,
never as permission to reuse a response.
For a positive response, `expiresAt` is the minimum of server time plus 60 minutes and the exact
TUF timestamp, positive-health, selected command, and active-lease expiries. It can never extend an
upstream lease. Boundary fixtures sign health at T0, lose quorum immediately, and request freshness
at health-expiry minus one millisecond; the returned lease expires with health, not 60 minutes later.
The independently served TUF timestamp object is at most 32 KiB, has CDN cache age at most 60
seconds, sustains the same 256 requests/hour/ring and 64-request minute burst with p99 ≤100 ms, and
returns no usable metadata on overload or partial transfer. Clients apply the same bounded backoff
and never reuse an expired timestamp. The deployed timestamp path and freshness endpoint must each
pass the 64/65-host normal, synchronized-startup, retry-wave, overload, cache-age, and recovery
corpus; passing one cannot qualify the other.
V1 has one global signed active-observe census capped at 64 target tokens across every agent pool
and all three rings; “fleet” below means that admitted census, not unbounded installations. The
release pipeline recomputes the union before every command and rejects N+1. A target remains
charged until its observe lease expires or a later signed off receipt is included; unreachable
hosts are never optimistically removed. Normal polling is at
most 128 requests/hour; one synchronized retry wave brings it to 192, and 25% admission headroom
brings the required floor to 240, below 256. Startup/retry polls add deterministic 0–120 second
jitter from the command-scoped target token. The deployed service must pass 64/65-host normal,
startup, retry, overload, and recovery tests before promotion; additional hosts remain dark.

The cap is state, not a count inferred from unlinkable public tokens.
`CompletionEvidenceActiveObserveCensusV1` has generation/previous digest and at most 64 private
entries keyed by
`stableLeaseId=HMAC-SHA256(pipelineCensusKey, stablePoolId || hostEnrollmentCommitment)` with
ring, current command epoch, current/previous command-scoped pool+target tokens, lease expiry, and
`reserved | active | releasing`. Only the protected release pipeline holds the census key/writes
the strongly consistent generation-CAS row. `stablePoolId` is the pipeline-private immutable pool
handle from the authenticated pool registry; it is independent of membership/census generations
and continuity-key rotations. Such changes atomically update the same leases in place at generation
CAS, including at N=64. A reimage creates a different host-enrollment commitment and may replace an
old lease in place only with a machine-signed retirement transition; otherwise it waits for a
verified off receipt or lease expiry. The signed census digest/generation/active count and
`activeLeaseRoot` are embedded in the promotion, TUF top-level target, release floor, and freshness
response; they do not require a new rollout generation. Stable lease ids/commitments never enter
public metadata. Renewal replaces one stable lease in place.
An unreachable host remains charged. A slot releases only when its lease expires or a verified
signed off receipt is included in a higher census generation.

For host-verifiable membership, each active private row has a public command-scoped leaf
`SHA256("instar/ce/active-lease-leaf/v1" || censusGeneration || ring || commandEpoch ||
poolScopeToken || targetToken || leaseExpiresAt || "active")`. Canonically sorted leaves form the
binary Merkle `activeLeaseRoot`: sort the fixed 32-byte leaf hashes unsigned-lexicographically and
reject duplicates; hash each internal node as
`SHA256("instar/ce/active-lease-node/v1" || left32 || right32)`; duplicate the final node as both
left and right at any odd-width level; and define the zero-leaf root as
`SHA256("instar/ce/active-lease-empty/v1")`. A canonical proof is a bottom-up array of at most six
`{side: left | right, sibling: bytes32}` entries; `side` is a closed one-byte enum naming the
sibling's position, including a repeated-self sibling for an odd node. Extra, missing, reversed,
duplicate, or noncanonical proof entries fail. No stable lease id appears in a leaf. A freshness request also
carries the exact command-scoped target token and remains at most 320 bytes. The service looks up
that token in the current CAS row and responds only for status `active`, echoing target token,
lease expiry, leaf, and its at-most-six-node inclusion proof within the existing 2 KiB response.
The host recomputes the leaf/root and requires exact equality with the command, floor, TUF target,
and freshness response. Reserved/releasing, stale-generation, wrong-target, proof-order,
leaf-substitution, and expired-lease fixtures all fail off.

All writers share one strongly consistent `CompletionEvidenceFreshnessFenceV1` with monotonic
generation and mode `idle | timestamp-refresh | ordinary-control | emergency-preempting`.
A routine timestamp row acquires it from idle and holds it through its freshness CAS. Ordinary
control prepare acquires it only after any timestamp row is freshness-committed, superseded, or
terminal; the prepare and fence CAS are atomic, so its expected timestamp/freshness predecessor is
current and cannot change. It holds the fence through package/TUF work, its linked late-signed
timestamp, and fused activation, then releases. A long or crashed publication may therefore let
the prior timestamp expire and turn clients off, but routine renewal cannot invalidate or wedge the
prepared candidate. A `write-uncertain` timestamp must be resolved or superseded before ordinary
prepare; no authority/head/census rebase is permitted. Tests cover refresh-before-prepare,
prepare-before-refresh, published/read-back-uncertain refresh, crash on each fence transition, and
fence/CAS N/N+1.

Command publication uses one strongly consistent, single-writer
`CompletionEvidenceControlPublicationV1` row with states `prepared | command-signed |
package-published | targets-published | snapshot-published | active | cancelled-before-sign |
stranded-off | publication-conflict` and the expected prior
active generation/head/freshness epoch. The initial prepare CAS verifies every per-pool aggregate,
reserves or replaces leases, allocates the next command/census and top-level-targets/snapshot versions, and durably stores
the exact aggregate refs, candidate private census, salts, unsigned canonical command payload, TUF
role/version allocation, package version, and signer/key generations. The deterministic command-sign
step CASes the exact signed command bytes/digest, package bytes/hash/length, and canonical signed
TUF top-level `targets.json` plus snapshot bytes/digests into `command-signed`.
`targets-published` means the one root-authorized top-level role was read back byte-for-byte.
Signing and every external
publication are idempotent by those exact bytes, digest, and version. While a row is
nonterminal no ordinary writer may allocate another command, census generation, targets, or snapshot
version. Recovery
must resume that exact row; it may not abandon it and mint a sibling from the same predecessor.
Before command signing or each external package/targets/snapshot write, the writer CASes a closed
`phaseIntent=sign | package-put | targets-put | snapshot-put` plus fence generation and prepared
promotion digest into the row. The side effect starts only after that intent is durable. Completion
CASes require the same live fence generation; response loss leaves the intent as “may have
succeeded,” never as pre-sign.

Publication proceeds package, top-level targets, then snapshot. A linked timestamp
refresh transaction publishes the first current timestamp as specified below. A CAS advances each
phase only after a read-back proves the exact immutable bytes. The final freshness-service CAS
requires the prepared prior epoch/head, atomically changes reserved leaves to active, and commits
the exact TUF versions, command head, census generation/digest/root, and lease set; that is the sole
activation point. The linked timestamp transaction's freshness commit and control activation are
one CAS. A client observing any pre-activation TUF stage gets a freshness disagreement and
turns consume off until recovery activates the same candidate. A crash after activation is closed
by rereading the already-active row. Ordinary cancellation is allowed only before command signing
or any external write; afterward recovery must finish the candidate unless the reserved emergency
floor below terminally marks it `stranded-off`. Irrecoverable signer/repository
compromise uses the fork-resolution and re-key path, not a second sibling.

Timestamp liveness is a separate durable transaction, not a reason to republish a command.
`CompletionEvidenceTimestampRefreshV1` has states `prepared | signed | published |
freshness-committed | insufficient-validity | expired | write-uncertain | cancelled-before-write`, expected prior timestamp/freshness epochs, exact unchanged
root/snapshot/targets versions and digests, next monotonic timestamp version, canonical bytes,
next threshold-signed positive-health artifact/digest,
`nextFreshnessEpoch=priorFreshnessEpoch+1`, issue/expiry, and attempt state. Its full nonterminal encoding is at most 48 KiB and is rejected
before write above that bound. One global single-flight row acquires `timestamp-refresh` fence mode
and prepares at the active timestamp's
issue time plus 30 minutes. It signs late, publishes and reads back idempotently, and requires at
least 50 of the 60 validity minutes to remain at publication. A freshness CAS then atomically sets
the prepared next freshness epoch and timestamp version/expiry while requiring the same control
head, snapshot, census, emergency-floor state, and prior freshness epoch; it also commits the exact
next positive-health digest/expiry, and every other field remains byte-equal. A client
that sees one side early fails off on version disagreement. Old/new response reordering,
same-epoch divergent timestamp, CAS retry, and rollback-race fixtures reject conflict. The first
timestamp for a pending control candidate uses the same state machine, with its final CAS fused to
control activation.

If signed timestamp bytes reach less than 50 remaining validity minutes before a proven publish,
the row becomes terminal `insufficient-validity`; recovery allocates a strictly higher timestamp
version for the same frozen snapshot/head. A PUT-success/read-back-timeout becomes `write-uncertain`:
the maybe-published version is never treated as freshness-committed, and recovery publishes a
higher version after repository access returns. A read-back-proven object that expires before its
freshness CAS becomes `expired` and is likewise superseded. In all cases no
command, census, targets, or snapshot byte changes. The publisher permits at most three
10-second attempts per rolling hour, retries after one and five minutes, then opens a 30-minute
breaker; signer/repository outage past 60 minutes predictably turns every consumer off. It retains
at most one nonterminal and one ≤8 KiB compact terminal timestamp row. TUF serves one atomically
replaced mutable `timestamp.json`; a private audit bucket retains at most 48 signed historical
objects or 1,536 KiB for 24 hours, then a daily signed digest-chain checkpoint replaces their bodies.
At most 30 fixed 4 KiB checkpoints remain; the 31st folds the oldest digest into a signed cumulative
anchor before deletion. Checkpoint or object-store failure stops new refreshes before N+1 and lets the current timestamp
expire off; persisted client maximum versions remain valid because versions only increase.
Emergency rollback has priority: a pre-write row becomes `cancelled-before-write`. A `published`
row is absorbed by putting its version in the rollback-floor CAS. For `write-uncertain`, rollback
immediately CASes off against the last freshness-committed timestamp; a client that fetched the
maybe-published higher version independently fails off on mismatch, so repository read-back cannot
delay the off floor. Recovery later supersedes that timestamp under the rollback candidate. Tests cover
steady-state rotations with no commands, >60-minute signer/repository outage, expiry before publish,
49:59 remaining validity, PUT-success/read-back-timeout with repository down, crash at every
timestamp/read-back/freshness boundary, N/N+1 attempts/rows/objects/bytes and checkpoint failure,
and rollback racing each phase.

The control-publication working record is capped at 1,536 KiB and rejected before write if the
candidate census, 64 aggregate refs, command, package, or full TUF metadata set would exceed it.
The ordinary journal retains at most one full nonterminal row and one ≤32 KiB compact active
terminal row. A physically reserved, non-borrowable emergency lane may hold one additional full
1,536 KiB row plus one 4 KiB floor record, for a closed 3,108 KiB combined ceiling;
after activation/read-back, canonical external bytes are replaced locally by their immutable refs,
hashes, lengths, versions, and phase receipts. The prior terminal is removed only after the next
candidate becomes active. Byte/row N/N+1, compaction-crash, and recovery-from-the-full-row fixtures
close the bound.
Including the timestamp working/terminal rows (48+8 KiB), current object (32 KiB), 24-hour audit
bucket (1,536 KiB), 30 checkpoints (120 KiB), current/previous positive-health artifacts (2 KiB),
and 18 KiB of fixed indexes/phase receipts, the publisher's named control-plane working/audit
ceiling is 4,872 KiB. One transaction charges the
whole projected footprint before its first write; N+1 stops before mutation and cannot borrow from
the emergency lane.

`CompletionEvidenceEmergencyKeyRecordV1`, distributed by the root-authorized TUF target named
above and cached in the installed release, contains generation, exactly three Ed25519 public keys,
threshold 2, validity interval, revocation floor, and three distinct custody-domain attestation
digests. The three principals are dedicated release-security custodians and may not share a key,
administrator, or custody domain with TUF root/targets/timestamp, control-release, freshness,
operator, security-reviewer, machine, or evidence-producer roles. A floor requires two distinct
current signatures over `instar/ce/emergency-floor/v1`. Its closed schema can encode only a
monotonic authority reduction to off; even all three keys cannot authorize observe, change a
rollout/census, or clear a floor.

Positive freshness uses a separate hot co-authority. Root-authorized
`CompletionEvidencePositiveHealthKeyRecordV1` contains generation, exactly three Ed25519 public
keys, threshold 2, validity/revocation floors, and distinct custody attestations for independently
administered online HSM/service principals. They share no key, administrator, or custody domain with
each other or any emergency, TUF, release, freshness, review, machine, or producer role.
`CompletionEvidencePositiveHealthV1`, at most 1 KiB, contains health epoch, exact positive-health
role generation, control head, emergency-floor epoch/digest/state, issued time, and expiry no later
than 60 minutes under `instar/ce/positive-health/v1`. This role honestly co-authorizes continued
positive freshness for an already selected head; its closed schema cannot choose/change a head,
rollout, census, command, or floor. Withholding quorum fails positive consume off; a compromised
quorum can prolong only the exact still-current head until its key record is revoked and cannot
create a new authority-increase by itself.

The timestamp-refresh attempt sends one authenticated canonical request of at most 512 bytes in
parallel to all three positive-health HSM services; each response is at most 256 bytes with a
three-second deadline, and two matching signatures must arrive within five seconds of the existing
10-second attempt. There is no per-signer retry; the existing three-attempt/hour budget permits at
most three requests/signer/hour and nine total. It atomically commits the resulting health digest/
expiry with the next freshness epoch and retains only current/previous artifacts (2 KiB). The
freshness service may issue an off-only response without health but refuses positive when it is
missing, expired, wrong-head/floor, stale-generation, or conflicted. Deployed 3/3, 2/3, 1/3, 0/3,
slow, duplicate, wrong-body, rotation, signer-loss, and compromised-quorum fixtures cover the role.
Normal rotation requires old and new health thresholds plus a new TUF key record; dual-role
revoke-and-rekey plus TUF root threshold handles loss/compromise. H2 is off regardless; a qualified
H3 needs fresh positive health for its exact head before positive activation.

Hosts obtain the actual independent bodies from
`POST https://updates.instar.dev/v1/completion-evidence/emergency-state`, a read-only replica of the
emergency CAS administered separately from the freshness signer. A ≤256-byte request carries a
random nonce, ring, build, and persisted health/floor high-waters; the no-store ≤8 KiB response
echoes the nonce and contains the exact current threshold-signed positive-health body, the exact
non-genesis emergency-floor body when present, and floor state. The fixed-host endpoint permits no
redirect or credentials, uses a five-second deadline, sustains 256 requests/hour/ring plus a
64-request minute burst at p99 ≤100 ms, and shares no signing key with freshness. Each freshness
cycle fetches TUF timestamp, emergency state, then freshness. Before every positive turn the host
verifies both threshold signatures against the cached root-authorized key records, generations/
revocations/validity, head, floor epoch/digest/state, health expiry, and persisted high-waters;
`satisfied` additionally requires the signed H2 command naming that floor. It then requires the
nonce-bound freshness response to carry the exact same body digests and state. Missing, unavailable,
invented, suppressed, or mismatched bodies fail off. Freshness-key-only compromise fixtures invent
health, lower/change/suppress pending floor state, and replay signed bodies across H0/H2/H3 and key
rotation; none yields a positive close.

The freshness service verifies, in order, the cached root-authorized key record, threshold and
custody separation, signature domain/schema, validity, generation at or above its persisted
emergency-role floor, revocation state, exact current active head/frozen freshness epoch and
preemption-marker digest, and strictly higher emergency epoch before its CAS. It persists the maximum role generation and emergency epoch
with the floor. Normal rotation requires threshold signatures from both old and new generations
plus the new TUF target. If the old threshold is lost or compromised, the existing dual-role
`revoke-and-rekey` fork resolution plus TUF root threshold may install a higher generation; consume
remains off until it is current. A compromised emergency threshold can cause
global denial of service but can never restore or increase authority. Wrong-key/domain, one-of-
three, shared-custody, stale/expired/revoked generation, replayed epoch/head, targets rollback,
signer-loss, compromise, and normal/recovery rotation
fixtures all fail least-authoritatively.

Before requesting threshold signatures, the authenticated reserved-lane writer acquires a strongly
consistent `emergency-preempting` mode on the shared fence with random nonce, current head/
freshness epoch, and a two-minute expiry. That CAS increments the fence generation and atomically
snapshots the exact ordinary row revision, prepared promotion digest, phase, and `phaseIntent`.
It blocks every further ordinary sign/phase/publication CAS as well as timestamp/control freshness
writes; a network operation already started has a durable intent and is conservatively classified
as may-have-succeeded. Signers bind the marker digest, frozen epoch/row revision, and closed rule
`cancel only when prepared with no phaseIntent; otherwise strand this promotionDigest`. The floor
CAS exact-compares the same snapshot. Any change rejects and requires a new marker and signatures.
A signature made before the marker, for a different marker, or after marker expiry is discarded.
Failure to obtain quorum CAS-restores the prior fence mode under a new generation only after proving
the frozen row unchanged; stale preemption or ordinary operations cannot resume by replay.

`CompletionEvidenceFenceRecoveryV1` rebinds any old-generation intent after failed/expired
preemption. One single-flight watchdog keyed by marker/fence generation starts at marker expiry,
uses at most one 15-second read-back attempt per invocation and three per rolling hour, and
atomically classifies the exact deterministic intent `not-started | absent | exact-present |
conflict`. `not-started/absent` rebinds the same command/version/digest intent to the restored fence
generation and idempotently resumes; `exact-present` advances that same phase under the new
generation. Timestamp conflict becomes `write-uncertain`; ordinary conflict becomes
`publication-conflict`, keeps consume off, and requires fork resolution. A sign intent is recovered
by one deterministic signer recall over the already fixed promotion digest before classification.
No outcome allocates a new command, census, TUF, or timestamp version. Inability to classify leaves
the row frozen and lets current leases expire off. Fixtures cover quorum timeout, coordinator crash
through marker expiry, sign/PUT success with response loss and no floor CAS, conflict, and every
phase under all four classifications.

Emergency off has an independent reserved preemption lane. A signed
`CompletionEvidenceEmergencyFloorV1` is at most 4 KiB and binds a monotonic emergency epoch, current
active head/freshness epoch, frozen ordinary row revision/promotion digest/phase intent and
cancel-or-strand rule, incident-evidence digest, exact marker digest, exact off tuple, issue time,
and emergency-role key generation. Its strongly consistent CAS
raises `rollback-pending` in freshness before allocating an emergency package or waiting for the
ordinary publisher, TUF repository, or timestamp read-back. Every current or later freshness
response carries the floor epoch/digest/state. State `rollback-pending` disables consume. H2
activation atomically changes that exact floor to `satisfied` while retaining its epoch/digest and
role-generation high-waters permanently; `satisfied` rejects earlier history but is not a kill bit.
The floor epoch/digest is never lowered or removed.

If the frozen ordinary row is `prepared` with no `phaseIntent`, the floor CAS marks it
`cancelled-before-sign` and the emergency command chains from the last active head. If any sign or
external-write intent exists, regardless of the observed response, the CAS marks the exact prepared
promotion digest `stranded-off`; its ordinary activation
CAS can no longer match the freshness epoch/floor. The reserved emergency command then chains from
that exact stranded digest, includes both artifacts in the suffix, and publishes through the same
phase machine without ever activating the ordinary tuple. This is the only permitted concurrent
control row and is a descendant, not a sibling. If signing or TUF publication remains unavailable,
the independent off floor remains sufficient; recovery finishes the exact emergency descendant or
uses fork-resolution/re-key, never restores the stranded ordinary candidate. Tests race emergency
floor CAS against every ordinary phase, command-sign success with response loss, package/targets/
snapshot PUT uncertainty, timestamp `write-uncertain`, signer and repository outage, and final
activation, and prove the dangerous ordinary tuple cannot become active afterward. The ordinary
N/N+1, membership/key-rotation, renewal, lease release, stale/forked CAS, and idempotent recovery
fixtures still apply.

The emergency-floor CAS atomically discards every reservation in candidate census C1 and retains
the last active census C0/root/leases until emergency command H2 is active. Readers persist separate
structural and authority high-waters: structurally they verify the contiguous signatures
`H0(active) → H1(stranded) → H2(off)` and persist H2; for authority they accept C0 through the floor
and H2 and never persist C1's generation, root, leases, or desired tuples as active maxima. H2 names
C0 and the floor's exact stranded H1 digest, so this one C1→C0 transition is an authenticated discard,
not a census rollback. Any H1 activation/lease proof fails against the raised freshness epoch and
stranded set. The next ordinary H3 chains from H2, prepares its new census from C0, and allocates a
generation above every structural census number seen in H1, preventing ABA. H3 is a newly qualified
`authority-increase` above the H2 command, satisfied emergency floor, current freshness epoch, and
all command/census high-waters; only its normal activation may restore observe. A crash after H2
publication but before its activation/satisfaction remains pending/off, and those two changes occur
in one CAS. Tests start H3 after every H1 publication phase, complete H3 reactivation, replay an old
pending-floor freshness response, and prove discarded reservations neither consume slots nor reappear.
Unknown build/ring, nonce mismatch, clock skew beyond five minutes, expired response, rollback,
same-epoch conflict, timeout, or service failure disables consume. Responses cannot be cached or
replayed across requests. This endpoint and its key rotation/runbook must be deployed and pass
fresh-valid-old-bundle-after-rollback, timestamp-only compromise, freshness-only compromise,
distinct-custody, and independent key-rotation tests before any observe command; it is a hard P21 foundation,
not a deferred fleet service.
The freshness service never signs a response whose latest applicable pool command or global
emergency-off command is expired at server time. Every canonical turn rechecks the freshness
response, TUF timestamp, independently verified positive-health body, selected pool-command,
global emergency-off, and active-census lease
expiry against the host's nondecreasing trusted wall high-water immediately before candidate freeze
and again before canonical close. Expiry at either boundary derives consume off; an action already
executed is neither retried nor hidden, but its whole close is visibly unverified. Command expiry
also prevents lease renewal, and the census slot remains charged until the signed lease expires or
a later verified off receipt releases it. The 30-minute polling cadence plus 60-minute freshness
hard expiry bounds connected-host rollback detection to 30 minutes normally and 60 minutes under a
scheduler pause; V1 makes no instantaneous-revocation claim. Boundary fixtures cover exactly eight
days, one millisecond beyond, an offline host, wall-clock rollback, scheduler pause, and a turn that
crosses each expiry.

The host does not mutate base config. It atomically installs one owner-only, no-follow, backup-
excluded promotion overlay at `state/completion-evidence-control.cbor`, capped at 8 KiB, containing
the selected group/target descriptor, applied full-command epoch/digest, previous digest,
rollout/checkpoint/floor, pool-scope token, pool-continuity-key generation, ring, base-config digest,
and last verified active-lease leaf/proof digest. This detached shard is not independently signed
and is never authority by itself: startup and every live turn must reload the exact cached full
signed command, verify the shard's membership and command digest, and obtain the current freshness
Merkle proof. If the bounded bundle cache or either proof is unavailable, consume is off. Write uses same-directory exclusive temp, file `fsync`, rename, then
parent-directory `fsync`; before rename the old overlay remains authoritative, after rename the new
tuple and replay high-water are one record. Startup verifies the entire record and its signed parent
before use. Missing, partial, corrupt, restored, or parent/signature-invalid overlay means consume off. A zero-state host may
run only explicitly configured capture-only dark; before consume it must fetch the current bundle.
Every maturation-registered ring host—off, dark, or observe—fetches the bundle at startup, after
update, and every six hours, single-flight by ring+installed-build, at most four five-second
attempts per rolling 24 hours. After a success the next fetch is six hours later; consecutive
failures schedule at 6h, then 12h, then open a 24-hour breaker. Observe hosts additionally obtain a
fresh TUF timestamp, independent emergency-state bodies, then the independent freshness response at startup and every 30 minutes,
at most three 15-second cycles/hour; a
failure disables consume immediately, retries at 1m then 5m subject to the same three-attempt
rolling-hour cap, then opens a 30-minute breaker.
`control_poll_state(kind PRIMARY KEY, next_seq, consecutive_failures, next_eligible_at,
breaker_until, max_wall_seen, last_boot_id, last_monotonic_at)` and
`control_poll_attempts(kind, seq, ring, build, started_at_wall, boot_id,
started_at_monotonic, wall_ms, outcome, PRIMARY KEY(kind, seq))` live in the private SQLite worker.
Single-flight acquisition counts every attempt whose start is in the prior 24 hours (`bundle`, max
four) or one hour (`freshness`, max three), inserts the next row, and updates state in one
transaction before I/O. Build/ring/update/downgrade changes only attempt context; it never changes
the host-wide key or rolling high-water. Monotonic time is compared only within the same boot id;
wall time may advance from a valid signed freshness response but may never fall below
`max_wall_seen`. Missing/corrupt state reconstructs conservatively as a full budget with a 24-hour
bundle/one-hour freshness breaker and consume off. Rows older than 24 hours are deleted only after
the admission count; at most four bundle plus 72 freshness rows exist. Restart, clock rollback,
build/ring churn, corruption recovery, and N/N+1 tests prove budgets cannot reset or fork.
No operator notice is emitted.

An expired TUF timestamp never authorizes acquisition or continued consume. When a freshness cycle
names the already installed snapshot/target versions, the newly fetched unexpired timestamp plus
the independent response renews their bounded use. A higher timestamp/snapshot/target version
immediately disables consume and schedules the exact TUF chain/bundle fetch under the bundle budget;
dark hosts may wait for their six-hour fetch because they have no positive authority. Tests cover
timestamp expiry at 61 minutes, unchanged and newer versions, target hash/length mismatch, and
freshness-current/TUF-unavailable plus TUF-current/freshness-unavailable.

The host writes one current signed `CompletionEvidencePromotionReceiptV1` (command/floor/overlay
digests, pool-scope and command-scoped target tokens, pool-continuity-key generation, applied time,
effective mode) into the private evidence database: canonical
size 512 bytes, one per target+command, at most 64 live rows and 64 KiB, 30-day retention. A new
bounded `/completion-evidence/promotion-receipts?scope=pool` route reuses authenticated pool
fanout/merge with a command+census-bound signed cursor: 16 machines/page, at most 16 receipts plus
16 current enrollment requests/24 KiB/page inclusive of the commitment below, 750 ms peer and
two-second page deadline, at most four pages/96 KiB inclusive and eight seconds total. It preserves missing/conflict and rejects a census change
rather than skipping a machine.
A page also carries an at-most-5-KiB
`CompletionEvidenceAggregatePageCommitmentV1`, signed by the enrolled pool-serving machine under
`instar/ce/ring-receipt-page/v1`. It binds page ordinal, route schema, pool commitment,
pool-continuity-key and membership generations, applicable census or enrollment-snapshot
generation, input-cursor digest (`genesis` on page 1), output-cursor digest or terminal-exhausted
marker, canonical page-payload digest, and at most 16 exact sorted
`CompletionEvidenceSourceStatusV1` records. Each source record is at most 256 bytes and is signed by
that source machine under `instar/ce/ring-receipt-source-status/v1`; it binds the source identity,
source certificate/key generation, exact pool/membership/census-or-enrollment snapshot,
command/window/query and page context digest, `status=complete | missing | conflict`, and
`receiptDigest?`, `enrollmentCommitmentDigest?`, or `conflictDigest?`. The page signature cannot
substitute for a source signature. The signed cursor and page commitment cover the same
predecessor/successor and exact source-record bytes.

The coordinator also obtains an at-most-3-KiB `CompletionEvidenceExpectedMembershipV1` from the
authenticated registry/pairing service. It is threshold-signed under
`instar/ce/pool-expected-membership/v1` by a dedicated 2-of-3 Ed25519
`completion-evidence-pool-membership-authority` role whose HSM shares are unavailable to enrolled
hosts, pool coordinators, source machines, and the release pipeline. It binds role generation,
pool commitment, pool-continuity-key and membership generations, monotonic membership epoch,
previous-body digest (`genesis` only at epoch 1), query scope and snapshot generation, exact sorted
expected source-identity digests/count `1..64`, issue time, and expiry no later than 15 minutes.
Knowledge of the shared pool-continuity HMAC cannot sign or verify this body.

The root-authorized top-level `targets.json`
`completion-evidence-pool-membership-authority-key` entry fixes the hash/length of a closed
`CompletionEvidencePoolMembershipAuthorityKeyRecordV1` target payload with role generation, three
pairwise-distinct public keys, 2-of-3 threshold, validity, predecessor digest, revocation floor,
and three pairwise-distinct HSM service principals, administrator principals, custody domains, and
root-verifiable custody-attestation digests. The verifier requires all three attestations and rejects
any key, service, administrator, or custody overlap among the shares or with TUF
root/targets/snapshot/timestamp, release, freshness, emergency, positive-health, operator,
security-review, coordinator, source-machine, ordinary machine, producer, or evidence-verifier
roles.
The full root→timestamp→snapshot→top-level-targets chain and exact target bytes are required for a
higher generation; rollback, fork, expired validity, same-generation key conflict, custody overlap with
release/coordinator/source roles, or a record below the persisted revocation/generation high-water
fails qualification. Two unavailable shares make membership issuance unavailable and hold rollout
before prepare; there is no HMAC, coordinator, cached-stale, or reduced-threshold fallback.
Compromise recovery uses the existing TUF flow: higher root metadata authorizes replacement
top-level-targets keys, and that threshold signs metadata naming the higher-generation replacement
record. No custom root field, delegation, or direct root signature over the domain payload exists.

The protected pipeline independently fetches the exact current membership body from the fixed-host
read-only registry route
`POST https://updates.instar.dev/v1/completion-evidence/pool-membership/current`.
The canonical at-most-128-byte authenticated request body carries the opaque pool commitment and a
fresh 32-byte nonce; neither value appears in the URL. The at-most-4-KiB response contains the body plus an
at-most-512-byte `CompletionEvidenceMembershipCurrentV1`, threshold-signed by the same dedicated
role under `instar/ce/pool-membership-current/v1`, binding nonce, pool/role generation, current
membership epoch/body digest/previous digest, server time, and expiry within 60 seconds. One
request per pool shares the eight-way concurrency/20-second total bound with aggregate fetch; there
is no retry within the invocation.

The pipeline verifies the TUF chain/role record, both threshold signatures, nonce, issue/expiry,
and byte-equality with the body embedded in the coordinator aggregate. Same epoch/different digest
or any value below the persisted per-pool epoch/digest high-water fails. A fresh/restored pipeline,
or one that missed intermediate epochs, may advance directly to the nonce-bound current head only
after durably persisting its epoch/digest high-water before prepare; the live current-head
signature is the bounded bootstrap/recovery authority, not an unbounded history scan. The body
hash chain remains audit evidence: the registry admits at most two membership epochs per pool per
rolling 24 hours, retains the latest 64 bodies for 31 days, and rejects a 65th retained body before
signing. It never grants activation authority without the nonce-bound current statement.
Unavailable, partial, stale, forked, rolled-back, or disagreeing registry state aborts before
prepare/CAS. A root, count, generation, cached body, or hash-chain suffix alone is insufficient.

The registry owns one strongly consistent `CompletionEvidenceMembershipIssuanceV1` row per pool
with revision, role generation, exact current epoch/body digest, and state
`idle | body-prepared | body-threshold-signed`. A body-sign intent binds the expected prior revision,
lane `body-issuance`, caller role, exact new body bytes/digest/epoch/predecessor, and expiry; the
body becomes current only by CAS after threshold signatures over that exact prepared revision. A
current-response intent binds lane `current-response`, authenticated release-pipeline caller,
current row revision/body digest, and request nonce. Each HSM share independently authenticates
the caller and lane, checks the closed signature domain and role generation, and reads the
strongly consistent registry row through its own read-only channel before signing. It signs only
the exact prepared body or exact CAS-current body/revision and nonce named by the matching intent.
Front-end assertions, stale snapshots, mixed revisions, cross-lane payloads, and arbitrary bytes
are insufficient. Compromised-front-end, arbitrary-body, smaller-list, old-head, cross-lane/domain,
caller substitution, and mixed-revision fixtures must fail with no threshold artifact.

The membership route and every success/error response set `Cache-Control: no-store`; intermediaries
and clients may not cache bodies, and error bodies carry no pool/member identifiers. The endpoint
allows no redirect, disables request/response body logging, and forbids pool commitments, member
identity digests, nonces, or exact-list digests in access logs, traces, metrics, and exception text.
Only aggregate status, latency, byte count, and coarse failure enum may be observed. Cache/proxy
replay, URL/query leakage, redirect, debug/error logging, trace sampling, and metrics-cardinality
privacy fixtures are required before observe activation.

The membership-current service authenticates only the protected release-pipeline role and enforces
a per-role token bucket of 256 requests/rolling hour with a non-borrowable 64-request minute burst;
one maximum 64-pool qualification therefore fits, while a 65th synchronized request is rejected
before any HSM call. Each accepted request fans out once in parallel to all three membership HSMs,
with one call/share, 500 ms per-signer deadline, one-second service deadline, no internal retry,
and p99 response latency ≤250 ms at the 64-request burst. Each signer must sustain 256
signatures/hour and a 64-signature minute burst with ≥25% measured headroom. A separate
non-borrowable lane permits the already capped 128 membership-body issuances/day
(`64 pools × 2`); current-response load cannot starve it. One unavailable share still permits 2-of-3;
two unavailable shares, rate exhaustion, timeout, overload, or partial signatures return no body
and hold qualification before prepare. Admission requires 1/64/65-pool normal and synchronized
fixtures, repeated failed-invocation throttling, body-issuance/current-response contention, one/two
share loss, HSM slowdown, overload, and bounded recovery after the rolling window.

A ring-qualification CI coordinator that is itself an enrolled target emits an at-most-32-KiB
`CompletionEvidenceRingReceiptAggregateV1`, a closed discriminated union signed under the existing
`instar/ce/ring-receipt-aggregate/v1` domain. Both variants contain `variant`, pool commitment,
pool-continuity-key generation, membership generation, ring, installed build, rollout generation,
coordinator machine certificate and signature, plus page count `1..4`, the ordered exact page commitments, and
the exact expected-membership body and `pageListDigest`. The digest is
`SHA-256("instar/ce/ring-receipt-page-list/v1\0" || canonicalCBOR(ordered exact page-commitment bytes))`;
commitments are ordered by contiguous ordinal starting at 1, and noncanonical encodings, count or
ordinal mismatch, and duplicate commitment bytes/digests are rejected.
Host enrollment/receipt/conflict membership is the canonical ordered union derived from the
source-signed status records and is not duplicated at aggregate top level. Missing membership is
the independently signed expected set minus valid unique source responses, plus any source status
`missing`:

- `variant=pre-command-enrollment` binds a qualification-window digest and
  `expectedPredecessor = genesis | { commandDigest, censusGeneration, censusRoot,
  freshnessEpoch }`. It is produced from the authenticated enrollment read before the command
  exists. Top-level post-command command/census/window/receipt fields, pool-scope token, and receipt
  digests are forbidden; nested `expectedPredecessor.*` is the sole permitted predecessor reference.
- `variant=post-command-receipts` binds the exact command digest, census generation/root, window
  digest, and pool-scope token. Receipt and enrollment-commitment digests come only from the
  ordered source-record union. The pre-command qualification-window and predecessor fields are
  forbidden.

The source-record required/forbidden matrix is closed:

| Variant | Status | Required | Forbidden |
|---|---|---|---|
| pre-command | `complete` | `enrollmentCommitmentDigest` | receipt, conflict |
| pre-command | `missing` | none | receipt, enrollment, conflict |
| pre-command | `conflict` | `conflictDigest` | receipt, enrollment |
| post-command | `complete` | receipt + enrollment | conflict |
| post-command | `missing` | enrollment | receipt, conflict |
| post-command | `conflict` | `conflictDigest` | receipt, enrollment |

The pipeline validates this matrix from each signed source record; the page signer cannot repair or
reinterpret a source status. All other combinations fail before union derivation. Cross-product
fixtures include missing-required, forbidden-present, `missing` carrying a receipt, and digest
transplant across variant/status/context/source key.

The 32 KiB aggregate cap budgets 20 KiB for four maximum page commitments, 3 KiB for the expected
membership body, 1 KiB for fixed fields/certificate/signature/digest, and 8 KiB for canonical-CBOR
framing/slack. Bounds fixtures fill all four pages and 64 maximum source records and reject the next byte or identity
before allocation. Digest fixtures
cover one/four/five pages, reorder, substitution, duplicate commitment, ordinal/count mismatch,
cursor truncation, noncanonical CBOR, and drop/substitute/reclassify-one source-reported
missing/conflict identity. Authority fixtures cover forged page-signer reclassification,
early-terminal omission, missing expected member, duplicate source status, stale membership body,
membership-root/list mismatch, source-key rotation, cross-context source-response replay,
ordinary-host/HMAC forgery, coordinator-forged smaller set, wrong algorithm/key purpose,
membership-role loss/rotation/revocation/fork, exact-list rollback, nonce replay, fresh/restored
bootstrap, missed 1/64/65 epochs, registry unavailability, and
pipeline/list disagreement, target substitution, stale snapshot/timestamp, unauthorized
delegation, targets-key compromise/replacement, root rotation, same-principal/same-custody shares,
duplicate keys/attestations, and every cross-role overlap named above.

The protected release pipeline fetches the content-addressed CI artifact, recomputes its digest,
verifies the closed discriminator, required/forbidden fields, coordinator signature/role, and all
page and per-source signatures/roles/key generations, the independent expected-membership
signature/exact list/current registry binding, common pool/key/membership/census bindings, ordinal and
signed-cursor predecessor/successor chain from genesis through terminal exhaustion, recomputed
`pageListDigest`, and duplicate-free exact source receipt/enrollment/conflict union. It rejects an
unexpected or duplicate source, derives missing as expected-minus-valid-response plus signed
`missing`, and accepts only when derived missing/conflict are empty. For a pre-command variant it requires the expected genesis/current predecessor,
pool/key/membership snapshot to match its live prepare inputs. For
a post-command variant it requires the exact command+census+window
before accepting it as the next ring's qualification input. It does not need a listener or access
to the private pool. One release input is a sorted set of 1–64 per-pool aggregates whose
total distinct host enrollment commitments is ≤64. Aggregate acquisition permits at most eight
concurrent fixed-host reads, 32 KiB per artifact and 2 MiB total, one attempt per artifact, and a
20-second total wall bound. The independently fetched membership responses add at most 256 KiB, so
combined release input is capped at 2,304 KiB. A timeout, partial set, duplicate, oversize, digest mismatch, or retry
request aborts the qualification invocation before prepare/CAS, leaving rollout state unchanged.
A later invocation rereads the full content-addressed set. For pre-command variants the pipeline
uses the command's fresh salt and derives every group's pool/target tokens. Post-command variants
bind the same group. The pipeline rejects duplicate stable leases, overlapping
host commitments, any nonempty derived missing/conflict set, or a union/census digest mismatch before the
global census CAS. Pool add/remove during any page invalidates that pool aggregate and restarts its
read; 1/2/64-pool, membership-change, timeout/partial/oversize, and union N/N+1 fixtures cover fan-in. The next ring requires exact-census,
conflict-free receipts from the prior command and window. N/N-1, crash-before/after rename,
partial-ring application, stale prior digest, restore,
promotion ABA, fresh off→dark→evidence→observe, restored-before-observe,
observe→rollback→old-observe replay, and cap+rollback tests prove no implicit activation gap.

The generation carrier is a new append-only `completion-evidence-rollout` replicated-store kind,
registered in both `ReplicatedKindRegistry` and its consumer. A bounded
`CompletionEvidenceRolloutRecord` contains schema/protocol version, monotonic generation, canonical
engine-registry digest, the exact bounded `CompletionEvidenceQualificationTupleKeyV1` set and
reference flags, the exact `qualificationCandidateDigest`, every global framework-coverage artifact/result digest, `authorizedMode`,
minimum compatible build, previous-record digest, exact spec/convergence/conformance digests,
CLASS artifact digests, independent maturation-reviewer identity/verdict/evidence digest, metrics
snapshot digest, required checkpoint epoch, issue/expiry time, and rollout rung. It is not local
requested configuration. The sole issuer is the protected release pipeline's
`completion-evidence-rollout-v1` Ed25519 key pinned in the release trust store. Neither a serving
holder nor an operator conversation can sign a record. The pipeline serializes issuance through one
protected environment and signs only after revalidating every embedded digest/verdict.

Existing HLC union replication carries records; no fictitious generic stateSync CAS is assumed.
Readers accept only the unique contiguous chain from the current release-signed checkpoint (genesis
is checkpoint epoch 0), where each `previousRecordDigest` names the exact prior record. Any fork from one predecessor—including N and
N+1 issued concurrently—two records at one generation, a gap, bad signature, unknown engine,
expired active tip, or missing required artifact fails closed to
`off-unverified`; records are immutable and retained through the 30-day evidence window.

`CompletionEvidenceCheckpointV1` contains checkpoint epoch, anchor generation/record digest,
cumulative prefix-chain digest, resolved/unresolved fork-set digest, previous-checkpoint digest,
pruned-through time, issue time, and release-key signature. The protected issuer may advance it
only after every record/evidence head in the summarized prefix has exceeded the 30-day window and
all prefix forks are explicitly resolved; the checkpoint becomes the signed derivation anchor for
the remaining suffix. Historical link expiry does not invalidate a chain—only the active tip's
expiry controls current authorization. A reader persists the maximum accepted checkpoint epoch,
requires the tip's `requiredCheckpointEpoch` to match, rejects rollback or two checkpoints at one
epoch, and fails off if the checkpoint/suffix is missing. Signature validity alone is insufficient
for a zero-state reader: a new, reimaged, or restored host must fetch the release-signed
`CompletionEvidenceReleaseFloorV1` from the control bundle and an independent nonce-bound freshness
response that names the same or higher floor. Checkpoint epoch, rollout generation, and promotion
command epoch must meet both. If either source is unavailable or disagrees, the host remains
`off-unverified`; an older still-unexpired checkpoint cannot activate the feature. Existing hosts
also require both floors not to be behind their persisted maxima.

A fork cannot be resolved by issuer assertion. The closed response space is `retain-off`,
`select-exact-branch`, or `revoke-and-rekey`. Selection requires an immutable
`CompletionEvidenceForkResolutionV1` naming every conflicting digest, the chosen digest, causal
incident-evidence digest, and new minimum floor; it must carry both an independent security-reviewer
signature and an operator signature before the release pipeline may reference it. The
`revoke-and-rekey` variant is a closed discriminated union with `roleKind=release | emergency-off |
positive-health`, old/new generation, role-specific old revocation floor, exact replacement
public-key or key-record digest, new-key proof-of-possession signatures, and causal incident digest.
For `emergency-off | positive-health` it additionally binds the exact root-threshold-signed TUF
root version that authorizes the relevant role keys, plus the standard targets-threshold-signed
top-level targets and snapshot-threshold-signed snapshot versions/digests that carry the replacement
record. If targets or snapshot role keys are themselves compromised/unavailable, a higher standard
root metadata version first authorizes their replacements; each new role threshold then signs only
its own metadata. No TUF root key custom-signs targets, snapshot, or the resolution artifact. The
security-reviewer and operator signatures remain required on the resolution. The `release`
variant pins the new release key above the old floor under the existing release recovery path.
No variant can change another role kind, reuse a replacement digest across roles, or lower any
persisted generation/revocation floor. Reviewer/operator absence or
disagreement remains `retain-off`; no checkpoint may summarize the fork. Resolution artifacts are
domain-separated, retained permanently in the release bundle audit history, and shown as a
security event rather than a successful automatic heal.

`CompletionEvidenceReviewRoleRegistryV1` is embedded in the signed Instar release and pins separate
security-reviewer and operator Ed25519 public keys plus generation, validity, revocation floors,
and independently administered custody-domain attestations. The security key is held only in the
independent review environment; the operator key is held only on the operator-controlled signing
device. Release/freshness infrastructure receives signatures over the canonical resolution digest
but has no signing access to either key; the two roles cannot share an administrator or custody
domain.
Those keys must differ from each other and from release, freshness, machine, and producer keys;
same-key/principal/custody-domain, unknown, expired, revoked, or stale-generation dual signatures
fail to `retain-off`. Each host and freshness floor persist the maximum accepted role generations;
zero-state readers require the nonce-bound freshness minima, preventing role-registry rollback.
Role rotation requires the old role key and the other role to sign the new generation; emergency
revocation requires the unaffected role plus the protected release key and can only reduce
authority until a normal two-role rotation. Cross-role substitution and rotation/revocation
fixtures cover every state.

The rollout kind is wired into `CoherenceJournal.JOURNAL_KINDS`, `DEFAULT_RETENTION`,
`ReplicatedKindRegistry`, and one store consumer with bounds: 24 KiB/entry, 66 live records, sole
writer = the pinned protected release pipeline, at most
two new generations per rolling 24 hours globally, and `KindRetention { maxFileBytes: 4 MiB, rotateKeep: 2 }`.
The entry budget is 16 KiB for the complete qualification tuple set/framing/reference flags, 6 KiB
for all pre-existing rollout fields/digests/signature, and 2 KiB canonical-CBOR slack. A maximum
66-record compact snapshot is therefore 1,584 KiB before bounded snapshot framing and remains below
the 4 MiB file cap. Max-set/max-record/snapshot N/N+1 fixtures reject before append or allocation.
At two generations per rolling day there are at most 60 window records plus one current checkpoint
and up to three frozen conflict/resolution records in 64 ordinary slots, plus two non-borrowable
emergency-disable slots. Ordinary issuance freezes once its 64 slots are occupied. Saturation, compaction
failure, or inability to durably append derives `off-unverified` immediately; a signed emergency
rollback may consume a reserved slot, but the fail-off state does not depend on the write. Once the oldest
prefix expires, the signed checkpoint replaces it and frees slots, so indefinite issuance remains
bounded. Before journal rotation the store writes a compact snapshot containing the release-signed
checkpoint plus every live suffix generation/conflict; startup verifies checkpoint, applies
snapshot, then newer journal rows.
N+1 rate/cardinality/entry bytes reject before append and cannot displace the current valid record.
Tests cover forged/rollback/same-epoch checkpoints, a fork before the checkpoint, ordinary-slot
saturation plus security rollback in both rollout and promotion logs, compaction failure,
pruned-prefix
fresh startup, fresh DB plus valid-but-superseded checkpoint/tip, restored-host rollback, current
floor unavailability, snapshot loss, N-1 readers, active-tip versus historical expiry, and years of
two-per-day accelerated issuance under the 66-record bound.

Atomicity is defined at the updated serving-process boundary: one record names the entire globally
qualified engine cohort, and a process activates all v2 code from that single record or none. It is
not a claim of simultaneous wall-clock mutation on offline machines. A v2 machine advertises its
protocol/generation in serving eligibility; a current peer refuses a lower/unknown generation.
Fleet completion cannot be declared until every serving-capable machine advertises the minimum
generation and an offline/rejoin fixture proves a lower-generation machine remains ineligible.
An unupgraded binary is outside v2 authority and must be updated or removed from serving before
operator rollout; it never contributes a v2 positive label.

On transition to observe-only:

- the completion hook reads the canonical envelope rather than `TurnEvidence` for every engine;
- the Claude transcript branch and every off-engine no-op branch are removed from the active
  verifier path;
- `CompletionClaimVerifier` becomes the adapter that maps canonical local-action clauses to the
  fixed renderer states; out-of-scope provider/global prose remains explicitly `unknown` and
  unverified rather than being borrowed from the legacy arbiter;
- `/completion-claim/observe`, audit, corpus, and Process Health accept versioned v2 scrubbed heads;
  legacy JSONL rows remain read-only for 30 days and are never combined with v2 rates;
- `ClaimObservationRecorder` remains a projection/observability facade and never becomes verdict or
  routing authority; `CompletionEvidenceVerifier` decides from already captured evidence before the
  recorder stores the scrubbed result.

Existing agents receive the enum/config and v2 schema through `migrateConfig()` and the normal
always-overwritten built-in hook migration. Database creation is expand-only; old readers ignore
the new database. Downgrade preserves the database inertly but is serving-ineligible for the v2
generation. Rollback on an updated process goes only to `off-unverified`, never back to a
Claude-privileged positive authority. The migration test proves the legacy hook is not callable in
dark or observe mode and that exactly one authority renders each turn.

## Scope and trust model

Instar trusts the model to produce ordinary work, but not to identify or prove what it completed.
The launcher derives the action candidate set from mediated action intents/results and renders the
final evidence block. The model may add commentary only in a visibly unverified channel.

This design trusts the local Instar launcher/supervisor and host key. It does not claim resistance
to a compromised host or malicious supervisor. Each verified clause displays a `verificationBasis`:

| Basis | Meaning |
|---|---|
| `trusted-local-supervisor` | owned launcher and supervisor observed the exact action |
| `independent-local-producer` | a separate local producer/store supplied the matching report/state |
| `authoritative-local-state` | a read-only verifier proved the exact causal local state transition |

These labels do not say “independent host” or “remote authority.” Process Health and audit preserve
the basis.

Out of scope and mechanically unsupported:

- sessions not launched through the owned boundary;
- network/provider durability claims such as push delivered or message sent;
- cloud, database, MCP/vendor, or background effects outside registered local mediation;
- eventual consistency, post-turn settlement, retries, or pending verdicts;
- proof that an unconfined engine performed no hidden filesystem/network action;
- verdict-based blocking or rewriting of the user's final response.

Canonical output ownership does require channel isolation: while an instrumented turn is open, the
child receives no Slack/Telegram/email/provider credential and every registered user-channel send
primitive is mediated by the launcher. A direct-send attempt is rejected before delivery, creates
an `unsupported` candidate, and invalidates canonical close. If an engine/build can reach a user
channel outside that boundary, `streamOwnership` cannot be `current` and the turn is delivered only
as visibly unverified freeform. This is output-integrity confinement, not verification that a
provider accepted or durably delivered a message.

An out-of-scope action receives row `disposition=unsupported-for-verification`; any clause about it
gets `verdict=unknown`. No generic **action** workflow/outbox machinery is needed. The bounded
control-publication coordinators above are intentionally custom durable workflows: their complete
closed states, idempotent side effects, retry limits, recovery transitions, and alternatives are
part of this authority review rather than hidden behind the action protocol.

## Canonical protocol

### 1. Launcher-owned action candidates

Before each mediated action, the supervisor mints an opaque 128-bit `actionId`, binds it to the
signed `{agent, machine, engine, session, turn, qualificationTupleKeyDigest,
qualificationCandidateDigest, reservedOrFinalRolloutGeneration}` launch context, and records the
registered action kind, schema version, and target identity hash. Results must echo the same
binding.

Candidate representation exists before schema lookup, so unsupported actions cannot disappear:

```ts
type ActionCandidateV1 = {
  actionIdHash: string;
  turnBindingHash: string;
  qualificationTupleKeyDigest: string;
  qualificationCandidateDigest: string;
  rolloutGeneration: number;
  kind: 'test-run' | 'build-run' | 'file-write' | 'local-command'
      | 'unsupported' | 'unknown' | 'action-limit-exceeded';
  observedClass: 'registered-local' | 'registered-out-of-scope' | 'unrecognized'
               | 'limit-sentinel';
  actionSchemaVersion: number;
  targetIdentityHash: string;
  safeDisplay: 'test' | 'build' | 'file-change' | 'local-command'
             | 'unsupported-action' | 'unknown-action' | 'action-limit-exceeded';
  disposition: 'uncharacterized' | 'eligible' | 'unsupported-for-verification';
  predicates: Array<{
    predicateId: 'execution-occurred' | 'suite-passed' | 'build-succeeded'
      | 'expected-file-transition-observed' | 'registered-command-succeeded'
      | 'verification-supported';
    expectedState: 'true';
  }>;
  overflowCount?: number; // saturated at 255; valid only for action-limit-exceeded
};
```

Supported kinds require `actionSchemaVersion >= 1` and their registered target extractor.
`unsupported | unknown | action-limit-exceeded` use schema version `0`; their target identity is
the domain-separated HMAC of the signed turn binding and respectively
`"no-target/unsupported" | "no-target/unknown" | "no-target/action-limit"`. No caller text or
unrecognized argument enters a sentinel hash. These same canonical values are copied into the
terminal envelope.

Every mediated intent creates exactly one candidate before invocation, including an unknown alias
or out-of-scope action. The launcher inserts it first into a bounded in-memory turn set, then
attempts durable intent capture. Durable enqueue failure retains the candidate with evidence
`availability=unavailable` and clause `unknown`.

The turn set holds at most 16 entries, reserving the final entry as
`action-limit-exceeded`; therefore at most 15 actions may execute. The next attempt creates
that sentinel and is rejected before invocation; further attempts increment only its count,
saturated at 255, and are rejected.
Pre-action durable enqueue is capped at 50 ms, result enqueue at 100 ms, and cumulative action-time
evidence wait at 500 ms/turn. Deadline/capacity never drops a candidate or permits an unrecorded
action.

Each in-memory candidate slot is capped at 640 bytes; candidate/index state is ≤16 KiB/turn and
≤1 MiB across 64 active turns. Buffered untrusted output is capped separately at 64 KiB/turn and
4 MiB/host. Queue metadata and renderer buffers bring the hard completion-evidence runtime-memory
ceiling to 6 MiB/host; allocation beyond any sub-cap rejects before action or falls to visibly
unverified freeform, never eviction of a live candidate.

### 1a. Machine-pinned turn boundary

V1 does not transfer an in-flight logical turn. The launcher's origin machine owns candidate
registration, action execution, evidence reduction, and canonical close for that turn. A local
monotonic `actionOrdinal` is allocated durably before every mediated action; the ceiling is 15 for
the turn. If routing/serving ownership moves, the engine process is terminated, the old host loses
the user-channel sink, and the new host may only start a new logical turn with a new binding. It
cannot continue, renumber, or canonically close the old turn. A partition or unavailable origin
therefore costs availability and may leave the old head partial/unknown; it never authorizes a
second host to execute the old turn's next action.

The stable inbound delivery id is bound to the durable inbound custody/dedupe ledger before model
launch. The first mediated intent marks that delivery `action-bearing`; ownership loss before a
terminal close changes it to `interrupted-possibly-executed`. A new holder must not replay its
prompt or any action automatically, even under a new turn id. It emits at most one launcher-owned,
visibly unverified interruption response from the dedupe record and waits for an explicit new
user/owner instruction. Automated resumption is allowed only for an action schema with a stable
idempotency key and an authoritative state reconciliation proving whether the prior effect occurred;
V1 defines no such automatic resumption for `local-command`.

This explicitly extends the current foundation; the states do not exist today.
`MessageProcessingLedger` schema N+1 adds `actionBearing`, `turnBindingHash`,
`firstActionIdHash`, `originServingMachineId`, `originServingEpoch`, `protocolVersion`,
`markerGeneration`, and terminal states
`interrupted_possibly_executed | interruption_reply_committed`. Before any first action invocation,
`markActionBearing()` fsyncs the marker, then candidate intent capture may proceed; failure rejects
the action. A crash after the conservative marker but before invocation may suppress a harmless
replay, which is safer than duplicating an effect. `beginProcessing()` refuses an action-bearing or
interrupted row; `isActedOn()` returns true for both new terminals; `reclaimStuck()` converts stale
`processing+actionBearing` to interrupted rather than received; and `stuckMessageRecovery` never
reinjects it, instead deduping the single interruption response.

Replay safety does not depend on receiving the action-bearing marker. At v2 adapter ingress—before
model launch—the durable inbound row is fsynced with the current serving machine/epoch and provider
delivery id/cursor; failure means the message is not launched. After any ownership change, a holder
may automatically process only a `received` row whose origin machine/epoch equals its current
serving epoch and whose provider cursor was first observed after that acquisition. Every foreign,
older, missing-origin, N-1, conflicting, or nonterminal delivery is conservatively
`interrupted_possibly_executed` and never reinjected. The lease handoff carries the provider-cursor
high-water; if it is absent/unverifiable, all pending pre-acquisition deliveries take the same
no-replay path. This can suppress a message that never reached an action, but cannot duplicate an
uncertain effect; the one interruption response tells the user to issue a new instruction.

Adapter admission is explicit:

| Replay class | V1 canonical-evidence admission |
|---|---|
| authenticated totally ordered cursor (for example Telegram `update_id`) | eligible only when the cursor high-water is durably carried by the serving handoff and the new id is strictly after it |
| unordered stable id with a unified acknowledged delivery-id set | eligible only after the id is durably acknowledged before launch and every future serving machine must sync that set before serving |
| unordered id without that acknowledged set (including current Slack event delivery) | ineligible for canonical evidence; existing pre-v2 action behavior continues, but the entire close is visibly unverified and makes no replay-safety claim |

Each adapter registers one replay class and its real handoff/ack fixture. Missing registration
defaults to canonical-evidence ineligible. An old unordered delivery redelivered after acquisition
with the origin row and action marker both absent must never enter the v2 evidence path as fresh;
the pre-v2 adapter remains outside this spec and cannot emit a canonical evidence block. Building
the unified acknowledged-id set for Slack is required before Slack can enter an observe cohort, but
does not block ordinary Slack actions or the other adapters' qualification.

`ReplyMarkerTransport` N+1 carries signed `{deliveryId, state, turnBindingHash,
firstActionIdHash, sourceMachineId, markerGeneration}` markers. The replay marker deliberately does
not carry `candidateSetDigest`: the candidate set is still open. The terminal committed-reply
marker separately binds the final terminal envelope digest. Merge is monotonic
`processing < action-bearing < interrupted < interruption-reply-committed`; an authenticated
matching `reply_committed` remains terminal, while any immutable turn/first-action/origin/source conflict fails to
no-replay and emits an interruption only if no authenticated committed-reply marker exists. N-1
peers that cannot represent the marker are reported partial and are forbidden from reclaiming that
delivery; a downgrade is serving-ineligible for v2 turns. Migration, old-schema, N/N-1, crash at
every boundary, a normal two-or-more-action growing candidate set, loss of the marker after local
fsync and after the external effect, remote marker loss/reorder/conflict, late origin rejoin, stuck recovery, and
duplicate-delivery tests prove the prompt cannot be re-injected.

This deliberate boundary avoids claiming a per-turn linearizable CAS primitive that
`FencedLease`/`LeaseCoordinator` do not provide. Transparent in-flight transfer would require a
separate converged specification and foundation. Cross-machine support in V1 begins after local
terminal reduction: other enrolled machines can read the bounded signed pool projection, and a
formerly local-only terminal head can gain an immutable pool mapping after continuity-key
recovery.

The origin signs each immutable canonical-CBOR `ActionEvidenceFragment` containing the pool turn,
action id, ordinal, source machine/key generation, candidate, and authenticated local sources. The
terminal envelope preserves the fragment digest, signature algorithm, signing key id, signature,
and each source producer's authentication metadata so a reader can re-verify provenance after
assembly; a missing or invalid fragment/source authenticator makes that action `unknown`. Close
uses only local captured fragments and never waits on the 750 ms/2 s pool read inside the 500 ms
close budget.

At close, the launcher—not the model—builds the complete mediated candidate set from those intents/results.
Every candidate is rendered from a fixed action-schema template:

- action identity and safe target display;
- execution/result enum;
- verifier status;
- per-clause verdict and verification basis;
- allowlisted artifact reference;
- fixed next-step sentence for `unknown` or `contradicted`.

The renderer emits one line per clause, using the clause's own basis. The only display template is:

```text
[{clause.verdict}] {safeDisplay} ({opaqueRef8}) / {predicateId} — {result}; evidence: {clause.verificationBasis | not-verified}
```

`verificationBasis` is required on `verified | contradicted` clauses and forbidden on `unknown`;
the renderer maps the absent unknown basis to fixed text `not-verified`. An action-level basis does
not exist, so mixed predicates cannot borrow another clause's producer or state proof.

Allowed transformations are closed:

| Action | `safeDisplay` | Allowed reference/artifact labels | Forbidden input |
|---|---|---|---|
| test | `registered test suite` | 8-character opaque target ref; `test report` | suite name, path, command, raw report |
| build | `registered build target` | opaque ref; `build report` | target name, path, flags, raw log |
| file write | `registered project file` | opaque ref; `state proof` | filename/path, content, diff |
| local command | `registered command class` | opaque ref; `execution result` | command, arguments, stdout/stderr |
| unsupported/unknown/limit | fixed sentinel label | no artifact label | caller/model-provided text |

`opaqueRef8` is a display-only truncation of the already scrubbed identity hash and is never used
for correlation. No free string crosses into the evidence block.

The model cannot omit, add, rename, or resolve candidates. There is no model-supplied `claims[]`
array in canonical mode.

The evidence block begins with the byte-exact signed renderer constant
`VERIFIED_SCOPE_PREFIX_V1`: **“Verified only for the listed local actions observed through
Instar's instrumented action seam. Hidden, bypassed, remote, or provider-side work was not observed
and is not certified.”** No global “done,” “complete,” task-level checkmark, or equivalent affordance is allowed.
A task-level completion claim requires a separate specification.

```ts
type CompleteTurnV1 = {
  schemaVersion: 1;
  turnBinding: string;
  operationId: string;
  mode: 'canonical' | 'freeform';
  candidateSetDigest: string; // launcher-provided; model echoes only
  freeformText?: string;      // allowed only in freeform mode
};
```

Exactly one final operation is accepted. A byte-identical retry is idempotent. A digest mismatch,
late operation, divergent repeat, or post-close operation causes the launcher-derived turn-close
state `mode=invalid`; no operation by deadline derives `mode=missing`. `invalid|missing` are not
caller-settable `CompleteTurnV1.mode` values. All affected clauses become `unknown`.

Canonical mode forbids arbitrary prose. An empty candidate set renders a non-completion response
and cannot say “done.”

```text
launch + signed turn
        │
        v
candidate registered before action
        │
        ├── supervisor evidence
        └── local verifier/native evidence
                    │
                    v
deterministic clause verdict
        │
        v
launcher-rendered scoped evidence block
```

### 2. Freeform presentation

Freeform engine text never receives a completion verdict. When `streamOwnership=current`, the
launcher may render its own evidence block for the complete mediated candidate set, followed by
engine text in a separate **Unverified commentary** container.

The commentary container is escaped plaintext. ANSI/control sequences, bidi overrides, HTML, and
launcher-style headings/badges are rejected or stripped. An unremovable launcher-owned unverified
marker sits outside the untrusted container. Without current stream ownership, the system delivers
only visibly unverified freeform output and no evidence block.

Freeform, invalid, and missing closes remain in coverage denominators. LLM/prose classification may
run dark for research but cannot alter candidates, rows, admission, or verdicts.

### 3. Stream ownership

Canonical authority is earned per engine through `StreamOwnershipContract`. The launcher must own:

- the child process group and PTY;
- stdout/stderr delivery;
- the completion control socket;
- cancellation and bounded TERM/KILL cleanup;
- the user-facing response sink;
- ordering and suppression of bytes after close.

Fixtures cover normal exit, late stdout/stderr, ignored cancellation, hung child, descendants,
terminal resize, restart, and reinstall. After `complete_turn`, output is buffered; the launcher
requests cancellation, waits at most 250 ms, applies the existing bounded cleanup, and discards late
bytes.

This proof concerns response-sink ownership, not sandbox confinement. Helper daemons, MCP/vendor
workers, auth helpers, auto-updaters, or direct filesystem/network side effects are outside this
contract. If they can write to the response sink, stream admission fails. If they perform an action
outside mediation, that action is unsupported and cannot be called verified.

Every displayed evidence block begins with that same byte-exact launcher-owned
`VERIFIED_SCOPE_PREFIX_V1` (line wrapping is presentation-only):

> Verified only for the listed local actions observed through Instar's instrumented action seam.
> Hidden, bypassed, remote, or provider-side work was not observed and is not certified.

That sentence is part of the signed renderer generation and cannot be shortened by the engine,
rollout config, or UI. The positive coverage label is deliberately
`observed-mediated-local-action-verification`; neither the label nor the percentage may be shown as
"task complete", "all work verified", or an equivalent global claim.

The build-time control-seam inventory is exhaustive over `IntelligenceFramework`. It records the
concrete current primitive and the gap that must close before admission; a planned primitive is not
`current`:

| Engine | Concrete current primitive | Admission gap |
|---|---|---|
| Instar-native | server/job supervisor owns action dispatch, child process, result, and final sink | add canonical turn-close binding and the real `test-run` fixture |
| Claude Code | Instar launcher/PTY plus hook event receiver and normalized tool events | prove launcher-owned candidate capture and a non-spoofable canonical close on a real build |
| Codex CLI | Instar launcher/PTY plus hook/OTel-normalized tool-call and tool-result events | prove the same close/output contract independently from rollout JSONL |
| Gemini CLI | launcher/PTY, session id, and hard-kill only; hook return contract is currently uncharacterized | build and live-probe an owned tool/action seam and canonical close; no transcript substitute |
| pi CLI | native agentic-session RPC with typed tool execution events, prompt/abort, and owned stdout | bind RPC action ids to the signed turn and prove final-sink suppression after close |
| Grok Build | launcher/PTY, one-shot JSON envelope, session id, and hard-kill; ACP is currently unverified | live-characterize ACP or another owned action seam and canonical close before admission |

The registry compares this table mechanically with the framework union and capability registry.
Adding an engine without a row fails CI. A row with an admission gap remains
`controlAvailability=unavailable`; prose, a transcript parser, or another engine's proof cannot
promote it.

Control and signing capability stay outside the untrusted engine boundary. The supervisor keeps
the host signing key in a platform credential store or isolated supervisor process that is not
readable from the child environment, argv, cwd, transcript, or tool filesystem. A child receives
only a single-turn, single-action opaque capability over an inherited descriptor. The local
control socket lives in a mode-0700 runtime directory, authenticates peer pid/uid plus the signed
turn capability, accepts one bound client, rejects cross-turn/action reuse, and is revoked at
close. If the host cannot enforce key isolation or peer binding from the launched engine, that
engine/build has `controlAvailability=unavailable`; same-uid convenience is not treated as a
security boundary.

Host enforcement is explicit:

| Host/runtime | Required implementation contract | Ineligible condition |
|---|---|---|
| Linux | supervisor-created process group/PTY; close-on-exec descriptors; channel credentials stripped; Unix socket peer check with `SO_PEERCRED`; bounded group TERM/KILL; executable/control-bundle hashes at spawn | any missing primitive, detached writer that retains the response sink, or unverified container/user-namespace mapping |
| macOS | supervisor-created process group/PTY; close-on-exec descriptors; channel credentials stripped; Unix socket `getpeereid` plus one-turn capability; bounded group TERM/KILL; executable/control-bundle hashes at spawn | any missing primitive, detached writer that retains the response sink, or unverifiable peer/process identity |
| Windows | ConPTY plus a Job Object with kill-on-close; restricted inherited handles; named-pipe ACL and client-process/token validation; channel credentials stripped; executable/control-bundle hashes at spawn | row remains uncharacterized until every primitive and negative fixture exists; POSIX evidence cannot promote it |
| shell/plugin wrapper | fixed argv without an intermediary shell where supported; otherwise the wrapper, plugin host, descendants, and final sink are all inside the same owned contract | shell startup files, plugins, or detached helpers can emit to the sink or invoke an unregistered action |

Platform qualification is per the exact `CompletionEvidenceQualificationTupleKeyV1` above. A host
may remain `not-verified`; the global engine-reference cohort rule does not let a supported local
tuple borrow another build or platform's proof.

The signed proof key is:

```text
engine/build + launcher/control-seam build + PTY policy + renderer generation
+ resolved executable realpath HMAC + executable content SHA-256 + control-adapter bundle SHA-256
+ reviewed evidence-component-bundle SHA-256 derived from object-bound local bytes
+ OS/runtime class + host boot id + install epoch + supervisor incarnation
+ rollout generation
```

A startup/restart/reinstall canary has a 10-second wall-clock bound, one isolated process group,
32 MiB temporary-state cap, and no external network. Timeout/failure sets
`streamOwnership=failed` and permits only freeform. The proof refreshes daily, expires after 36
hours, is host-local, and cannot survive a boot/install/supervisor epoch change. The supervisor
resolves and hashes the executable and control-adapter bundle before every new engine process; a
persistent process is bound to the identities captured at its spawn. Any identity change
invalidates the proof and requires the canary before another canonical turn, even inside 36 hours.

Hash-to-exec is object-bound, not path-trusting. Linux opens the executable no-follow, hashes and
`fstat`s that descriptor, then uses `fexecve`/`execveat`; macOS keeps the no-follow descriptor and
admits no action until the spawned pid's actual vnode/code-signature/content identity matches it;
Windows holds a non-share-delete image handle and admits no action until the child process image
handle/path/signature/content matches. The control bundle follows the same descriptor/handle
discipline. If a platform/runtime cannot bind or attest the spawned image before actions, that
tuple remains uncharacterized. Swap-between-hash-and-exec, symlink, updater, inode reuse, and plugin
replacement fixtures must fail admission.

The recurring canary is a P19-bounded sentinel. Its dedupe key is
`engine/build/OS/runtime/proof-identity`; one single-flight attempt may run for that key. Startup,
restart, reinstall, identity-change, and daily triggers coalesce. A failed key uses 1m/5m/30m/6h
backoff. Each of at most 16 locally registered proof keys receives one staggered baseline attempt/
24h (≤160 seconds total); additional tuples remain uncharacterized. Failure retries use a separate
host-wide budget of at most four attempts and 40 seconds per rolling 24 hours, then open a
24-hour breaker. Three fail-after-success transitions in 24 hours also open the breaker. Breaker,
attempt, outcome, and next-eligible timestamps persist in the private evidence database and survive
restart; a new executable/control identity creates a new key but cannot reset the host-wide
retry budget or receive a second baseline that day. The metadata-only audit is bounded to 31 daily buckets. Sustained-failure and
overlapping-trigger tests prove no continuous respawn. This component emits no operator notice;
failure simply makes the row ineligible and visible in Process Health.

## Evidence contract

### 1. Bounded envelope

```ts
type Fixed16 = Uint8Array & { readonly byteLength: 16 };
type Fixed32 = Uint8Array & { readonly byteLength: 32 };
type Fixed64 = Uint8Array & { readonly byteLength: 64 };

type CompletionEvidenceEnvelope = {
  schemaVersion: 1;
  engine: 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli' | 'grok-build' | 'instar-native';
  turnOriginMachineId: Fixed16;
  closeMachineId: Fixed16; // V1 requires equality with turnOriginMachineId
  evidenceId: Fixed32; // one bounded head per logical turn
  hashKeyId: Fixed16;
  projectionAvailability: 'pool-projectable' | 'local-only';
  poolTurnId?: Fixed32; // required only when pool-projectable
  sessionIdHash: Fixed32;
  turnIdHash: Fixed32;
  qualificationTupleKeyDigest: Fixed32;
  qualificationCandidateDigest: Fixed32;
  rolloutGeneration: number;
  candidateSetDigest: Fixed32;
  actionCount: number; // 0..16, must equal actions.length
  orderedActionIdsDigest: Fixed32;
  producerKeys: Array<{
    kind: 'supervisor-journal' | 'native-event' | 'local-verifier';
    generation: Fixed16;
    publicKey: Fixed32;
    validFrom: number;
    validUntil: number;
    machineCertificateAlgorithm: 'ed25519-v1';
    machineCertificateSigningKeyId: Fixed16;
    machineCertificate: Fixed64;
  }>; // max three; certificate is signed by the enrolled origin machine identity
  actions: Array<{
    poolActionId?: Fixed32; // required only when pool-projectable
    actionIdHash: Fixed32;
    sourceMachineId: Fixed16;
    fragmentDigestAlgorithm: 'sha256-cbor-v1';
    fragmentDigest: Fixed32;
    fragmentSignatureAlgorithm: 'ed25519-v1';
    fragmentSigningKeyId: Fixed16;
    fragmentSignature: Fixed64;
    actionOrdinal: number;
    actionKind: 'test-run' | 'build-run' | 'file-write' | 'local-command'
              | 'unsupported' | 'unknown' | 'action-limit-exceeded';
    actionSchemaVersion: number;
    targetIdentityHash: Fixed32;
    disposition: 'uncharacterized' | 'eligible' | 'unsupported-for-verification';
    safeDisplay: 'test' | 'build' | 'file-change' | 'local-command'
               | 'unsupported-action' | 'unknown-action' | 'action-limit-exceeded';
    overflowCount?: number;
    result: 'ok' | 'error' | 'unknown';
    clauses: Array<{
      predicateId: 'execution-occurred' | 'suite-passed' | 'build-succeeded'
        | 'expected-file-transition-observed' | 'registered-command-succeeded'
        | 'verification-supported';
      expectedState: 'true';
      verdict: 'verified' | 'contradicted' | 'unknown';
      verificationBasis?: 'trusted-local-supervisor' | 'independent-local-producer'
        | 'authoritative-local-state'; // required verified/contradicted; forbidden unknown
    }>; // max six; basis is charged per clause
    sources: Array<{
      kind: 'supervisor-journal' | 'native-event' | 'local-verifier';
      digest: Fixed32;
      producerMachineId: Fixed16;
      producerKeyGeneration: Fixed16;
      authAlgorithm: 'ed25519-v1';
      authKeyId: Fixed16;
      authSignature: Fixed64;
    }>; // max three
    availability: 'complete' | 'partial' | 'unavailable' | 'conflicted';
    artifactRef?: {
      kind: 'test-report' | 'build-report' | 'state-proof' | 'execution-result';
      identityHash: Fixed32;
    };
  }>; // max 16, including reserved overflow sentinel representation
  capturedAt: number; // signed 64-bit epoch milliseconds in canonical CBOR
  revision: number;
  terminalDigest: Fixed32;
  terminalSignatureAlgorithm: 'ed25519-v1';
  terminalSigningKeyId: Fixed16;
  terminalSignature: Fixed64;
};
```

Raw prompts, commands, arguments, results, transcript paths, filenames, user text, secrets, and
provider identifiers are forbidden. Closed extractors produce target hashes and allowlisted
display summaries before allocation. The evidence envelope is capped at 21 KiB. The independent
candidate set and turn envelope contain up to 15 executed actions plus the reserved overflow
sentinel.

The CBOR decoder is streaming and length-limited before allocation. Opaque ids, HMACs, hashes, auth
tags, and key-generation ids are fixed 16 or 32 bytes as declared by the schema codec; Ed25519
signatures are 64 bytes; timestamps are signed 64-bit epoch milliseconds; machine and key ids are
16-byte registry handles; `artifactRef.kind` is a closed one-byte enum; and no free string appears
in the binary envelope. A noncanonical encoding, duplicate key, indefinite-length item, oversized
item, unknown enum, or trailing byte is rejected before object materialization.

Every completion-evidence canonical-CBOR Ed25519 preimage is
`UTF8(domain) || 0x00 || canonicalCBOR(payload)`; domain is verified before schema dispatch and is
never inferred from key reuse. Standard TUF root, timestamp, snapshot, and targets metadata instead
use TUF 1.0 canonical serialization, signature, threshold, and role rules; they are never wrapped in
or verified under an `instar/ce/*` domain. Closed completion-evidence v1 domains are
`instar/ce/{control-bundle|rollout|qualification-candidate|checkpoint|promotion|promotion-receipt|ring-receipt-source-status|pool-expected-membership|pool-membership-current|ring-receipt-page|ring-receipt-aggregate|release-floor|freshness|emergency-floor|emergency-key-record|positive-health|positive-health-key-record|fork-resolution|review-role-registry|enrollment-request|turn-binding|terminal|action-fragment|reply-marker|pool-mapping|key-history-revocation|key-history-snapshot|canary|command-witness}/v1`
and `instar/ce/{producer-certificate|source}/{supervisor-journal|native-event|local-verifier}/v1`.
The braces denote a closed expansion, not bytes in the preimage. Missing/unknown domain or schema
version fails closed. Negative fixtures transplant
valid signatures across every record role, producer kind, schema version, and key purpose and must
all fail.

The two pagination cursors are fixed 256-byte canonical-CBOR HMAC tokens, not Ed25519 records.
Their preimages use distinct domains `instar/ce/pool-head-cursor/v1` and
`instar/ce/promotion-receipt-cursor/v1` and bind schema, endpoint/filter, pool/census generation,
command when applicable, page index, last ordered key, issuing server instance, issued time, and
expiry no later than five minutes. Keys are owner-only per-serving-instance random HMAC-SHA-256
keys; restart/serving movement invalidates the cursor and requires a fresh page 1. Unknown key,
wrong endpoint/domain, mutation, expiry, or census change returns `409 cursor-invalid` and never
skips ahead. Cross-purpose transplant, page deletion/insertion, wrong-instance, expiry, and key-
rotation fixtures cover both cursor roles.

All low-entropy target, action, turn, source, and artifact identifiers use keyed HMAC-SHA-256 with
an explicit v1 domain string; bare hashes of paths, suite names, command classes, machine names, or
small result payloads are forbidden. When pool-projectable, `evidenceId` is a domain-separated HMAC over the pool-stable signed logical
turn binding, independent of the machine that closes it. In local-only mode it is a host-scoped
opaque id and cannot be compared pool-wide. Each action retains its stable 128-bit action id,
source machine/key generation, and origin-local ordinal inside that turn head.
No identity is derived from timestamps or text. The ingestion boundary authenticates the producer
and stamps engine/source/build; caller-supplied identity is rejected.

The turn origin is fixed in the signed binding and cannot change; `closeMachineId` must equal it.
Head/day quota is charged to that origin; staging/source bytes are also charged there, and every
local database retains the unconditional 10,000-head/384 MiB ceiling. A routing move cannot mint a
fresh allowance for the old logical turn; the new host must start a separately identified turn.

Each action fragment and source carries its algorithm and key id because a pool projection can
contain several retained generations. The fragment's Ed25519 signature covers its canonical
digest, turn/action identity, exact qualification tuple/candidate/generation identity, candidate,
predicate clauses, and ordered source-authenticator array.
Each write-isolated producer signs its own canonical source record with a producer Ed25519 private
key unavailable to the engine and other producers; the supervisor cannot mint an independent
producer signature. The terminal origin signature covers schema/turn identity, exact qualification
tuple/candidate/generation identity,
`candidateSetDigest`, exact `actionCount`, ordered action ids/digest, every signed fragment,
the exact producer-key dictionary/certificate signer ids, revision, and `terminalDigest`. A missing/reordered/subset action list, including omission of the
overflow sentinel, invalidates the whole terminal envelope before any positive clause or coverage
read. Verification public keys remain available in the enrolled pool key registry
for the 31-bucket retention window, then expire with the evidence. Rotation starts a new generation
without re-signing old rows. A compromise/revocation marks every row under that generation
`unknown` and freezes rollout; it never silently trusts a newer signature over compromised history.

The signed turn binding pins exactly one producer generation for each of the three source kinds.
It also pins exactly one qualification tuple key, qualification candidate digest, and
reserved/final rollout generation. Every intent, result, source record, fragment, terminal, and
metric event must exact-match those values; a component/update/generation change during the turn
makes the turn ineligible and its affected clauses `unknown`, never rekeys an open turn.
Every producer in that turn must use the pinned generation; rotation affects newly created turns
only. A pinned key that becomes unavailable or revoked before close makes that source/action
`unknown` and is not replaced in place. Thus the terminal dictionary's max-three bound remains
exhaustive even when a long turn overlaps rotation. Rotation-during-turn fixtures verify old/new
generations cannot be mixed or silently substituted.

The terminal's bounded `producerKeys` dictionary is the historical distribution path: each public
key record is certified by the origin's existing `MachineIdentityManager` Ed25519 identity over
machine id, producer kind, generation, public key, and validity bounds. Remote readers resolve that
exact `machineCertificateSigningKeyId` generation from the paired `MachineRegistry`/key history—key
scanning is forbidden—verify the certificate, then verify each source
and fragment signature without receiving any private key. A `completion-evidence-key-history`
append-only replicated-store kind carries the same public records plus signed revocations across
the pool; it uses dual registry/consumer wiring, HLC union, immutable generation keys, and conflict
preservation—not last-writer-wins. Records/tombstones remain until every referencing head plus one
GC bucket has expired. Reverse references include both producer generation ids and exact machine-
certificate signing-key ids. Unknown/conflicting/revoked identity or producer generations make affected
remote clauses `unknown`. N/N-1, offline rotation, revocation, missing history, and 31-bucket GC
tests cover the path.

The key-history kind is likewise added to `JOURNAL_KINDS`, `DEFAULT_RETENTION`, the replicated-kind
registry, and its consumer with 1 KiB/entry, at most 16 new key/revocation records per
source-machine/UTC day, 32,768 live key records plus 32,768 tombstones pool-wide (64 enrolled-machine
feature ceiling), and `KindRetention { maxFileBytes: 16 MiB, rotateKeep: 4 }`. A signed compact snapshot is
written and fsynced before rotation and contains every still-referenced generation and tombstone;
boot applies it before the journal tail. GC may remove a generation only after a reverse-reference
scan proves no unexpired head/mapping uses it and the extra bucket elapsed. At capacity, rotation
is refused before a new key is used, the old valid key remains active, and rollout freezes rather
than shedding history. Rotation-storm, forged-writer, snapshot-loss, N/N+1, compaction, and
archive-boundary tests prove a referenced key/current rollout cannot be rotated away.

Observe-only admission requires an authenticated enrolled-machine census of at most 64. The pool
read API may still page diagnostics for larger pools, but completion evidence stays off-unverified
until the pool is reduced or a separately reviewed capacity generation raises all bounds. At
`64 × 16 × 31 = 31,744`, live records remain below 32,768; the equal tombstone cap covers a full
rotation wave. N=64/N+1 membership and rotation tests prove the census and storage math agree.

That history also retains each origin machine-identity public generation used by a terminal or
producer certificate. A new machine-identity generation must be enrolled before use and is
cross-signed by the prior enrolled identity or the existing pairing authority; an unanchored
self-signed key is rejected. Thus `terminalSigningKeyId` and producer certificates remain
verifiable after rotation without making private keys portable.

The pool continuity HMAC key is a distinct unified credential distributed only through the existing
authenticated `SecretSync` path with a generation id. Private key material never enters stateSync
or evidence. Rotation overlaps old/new generations until all 30-day heads expire; loss leaves new
heads local-only, and revocation freezes projection. The public machine signature—not knowledge of
the shared HMAC—is the provenance authority for a binding.

At logical turn start the host uses its provisioned agent-pool continuity key to mint a random
opaque `poolTurnBinding` signed to agent, enrolled source machine, logical session/turn, and pool
key generation; no live coordinator call is required.
`poolTurnId` is its pool-safe opaque projection and each `poolActionId` is a domain-separated HMAC
over `{poolTurnBinding, sourceMachineId, actionId}`. Launch, persisted envelope/head,
projection, and machine-B reads verify the signature and preserve originating machine/hash-key
generations. If the continuity key is unavailable, local verification proceeds from the host turn
binding while cross-machine projection is `unavailable`; no local verdict depends on pool
availability, and V1 never starts an action for the same logical turn on another machine. No
timestamp, text, target, or caller-selected id participates in the join.
When `projectionAvailability=local-only`, pool ids are absent in the envelope and nullable in the
local head/staging schema; such a head is excluded until authenticated reconciliation succeeds.
`pool-projectable` requires all pool ids and a valid continuity signature.

After continuity-key recovery, a bounded reconciliation worker processes at most 200 retained
local-only heads per tick, oldest first, every five minutes at ≤10% duty cycle. It persists a
`{capturedAt,evidenceId}` cursor and backlog count/oldest age in `reconciliation_state`, wraps once
at end, and repeats until a full pass finds no eligible head. Production writes have priority. Each
head has at most five attempts; terminal identity failures quarantine that mapping, while transport/
key outages open a 10-minute breaker and resume from the same cursor. At the maximum 6,200-head
backlog, an otherwise healthy worker drains in at most 31 productive ticks without an unbounded
single pass. The same supervisor that signed the host turn binding proves source machine,
session, turn, actions, and terminal digest, then mints a new pool mapping without changing the
local verdict or pretending it existed earlier. The projection records `reconciledAt` and the old
host-scoped id hash. Identity ambiguity, a missing host key generation, or a terminal mismatch
leaves the head local-only and `unknown` on remote reads. Reconciliation is idempotent, metadata-
only, and audited; it never copies raw evidence or creates verdict authority on another host.

Revisions are monotonic: `partial → complete` and `unknown → ok|error`. Identity or terminal
mutation, revision gaps, replay across turns, or conflicting terminal evidence sets
`availability=conflicted` and clause `unknown`.

### 2. Supported local action schemas

| Action | Fixed predicates | Exact contract | Seed/cross-engine redundancy |
|---|---|---|---|
| `test-run` | `execution-occurred`; `suite-passed` | owned process identity/exit plus parser-confirmed bounded report for the exact suite/config digest | supervisor journal + test-runner report from separate producer/store |
| `build-run` | `execution-occurred`; `build-succeeded` | owned process identity/exit plus parser-confirmed bounded build report for exact build/config digest | supervisor journal + build artifact/report verifier |
| `file-write` | `expected-file-transition-observed` | supervisor-owned operation id plus authenticated before/after reads proving the declared version/digest transition | supervisor journal + read-only filesystem state verifier |
| `local-command` | `execution-occurred`; `registered-command-succeeded` | exact registered command class executed with matching process identity and exit/result; does not certify any larger state change | supervisor journal + signed `CommandWitness` or proven native event |

Predicates are minted from the reviewed action schema before invocation; the model cannot add or
rename one. A failed test may therefore have `execution-occurred=verified` and
`suite-passed=contradicted`. An unsupported/unknown sentinel carries only
`verification-supported`, which is `unknown` or `contradicted` only from an explicit matching
unsupported registry row—never from missing evidence.

`CommandWitness` is a small launcher-spawned, write-isolated wrapper with its own producer key. It
receives only a registered command-class id and fixed argv digest, owns the child process handle,
and signs start identity plus terminal exit/signal/result enum to the narrow report descriptor. The
engine cannot write its store or use its key; the supervisor independently records intent and the
expected process identity. Wrong argv, reused process, missing terminal event, wrapper/supervisor
disagreement, or a wrapper launched by the engine yields `unknown`. A CLI/OS tuple without this
witness or a separately proven native event keeps `local-command` dark/uncharacterized. Neither
source certifies filesystem/network confinement or a state change beyond command execution.

A successful tool return is insufficient when the schema requires a report or state transition.
Prior state already matching, missing before-version, wrong target, concurrent writer, stale report,
or conflicting sources yields `unknown`, not verified.

"Separate producer/store" means write-isolated from the subject engine, not merely a second file.
The supervisor launches the report producer/verifier with a fixed-schema, write-only inherited
descriptor or narrowly scoped broker capability that the engine never receives. The report store
accepts authenticated producer identity and exact action/target binding; engine-writable paths,
environment secrets, transcript content, and caller-selected report ids are rejected. Fault tests
attempt to forge both sources from the engine process. A `local-command` row with no proven native
event or independent state verifier stays `uncharacterized`; supervisor-only success can never make
that row eligible.

The seed row is Instar-native `test-run`:

- primary: server job supervisor writes intent and paired exit/result to the recorder during work;
- redundancy: test-runner process writes a content-addressed bounded report to a separate artifact
  store; a read-only parser verifies suite/config/result before close;
- faults: independently drop/corrupt each producer and store, stale report, wrong suite/config,
  parser failure, and shared-filesystem failure;
- disagreement: `availability=conflicted`, verdict `unknown`.

For Claude, Codex, Gemini, pi, and Grok, the instrumented supervisor remains the primary. A row
becomes eligible only when the same action-specific verifier works from a real engine fixture, or
a proven native event provides the redundancy. A transcript parser is not fault-separated from an
engine-owned transcript and cannot occupy the redundancy slot.

### 3. Engine coverage matrix

| Engine | Required close path | Instrumented primary | Eligibility requirement |
|---|---|---|---|
| Instar-native | server-owned run close | job supervisor | real `test-run` fixture + report verifier |
| Claude Code | proved launcher tool/control seam | supervisor journal | real fixture for each admitted local row + action verifier/native redundancy |
| Codex CLI | proved launcher tool/control seam | supervisor journal | same; rollout JSONL is diagnostic only |
| Gemini CLI | newly built and live-probed launcher tool/control seam | supervisor journal | same; current session-id/hard-kill capability alone is insufficient |
| pi CLI | typed RPC action/control seam | supervisor journal | same; RPC ids and final sink must bind to the signed turn |
| Grok Build | newly live-characterized ACP or equivalent owned action/control seam | supervisor journal | same; one-shot JSON/session-id/hard-kill capability alone is insufficient |

Each row declares producer process, storage path, capture timing, credential dependency,
correlation key, and `controlAvailability`. Fault injection must independently break the primary
producer/store and the redundancy producer/store. Shared host/kernel/supervisor dependencies are
disclosed; the UI never calls local redundancy host-independent.

## Deterministic verifier

For each launcher-owned candidate and each schema-minted predicate,
`CompletionEvidenceVerifier` performs exact schema, target, proposition, and causality matching:

- `verified`: complete matching evidence proves that exact predicate's expected state;
- `contradicted`: complete matching explicit failure or authoritative local negative state disproves
  that exact predicate;
- `unknown`: missing/partial/conflicted evidence, unsupported schema, different target, stale
  report, missing causality, or capacity/key failure.

Absence is never contradiction. Evidence for a different target is never borrowed. The verifier
makes no `IntelligenceProvider` call and reads no assistant prose.

At close it reads already captured local evidence only. It starts no command, report generation,
filesystem mutation, provider read, retry, or background job. A late event cannot mutate the
immutable displayed verdict.

## Verify-the-state declarations

Each check states both its measured condition and the narrower claim it certifies. The listed
corroboration is causally tied to the state and isolated from engine-written prose. `unknown` never
inherits a favorable result.

| Check | Symbol/condition measured | State certified | Independent corroboration and two-way contest | Unmeasurable / least-harmful result |
|---|---|---|---|---|
| engine census | canonical `IntelligenceFramework`/`SUPPORTED_FRAMEWORKS` union plus explicit `instar-native` | which engines this generation must cover | compiler-exhaustive registry and synthetic-engine negative control; a hand list may be present while an engine is absent, and a disabled build may be listed without being runnable | generation cannot activate; census is unresolved |
| rollout authorization | unique contiguous release-signed record chain plus exact spec, convergence, CLASS, maturation-review, metric, registry, and build digests | this whole-cohort generation/rung is authorized as the maximum mode an updated process may consume | pinned release trust root, protected single-writer pipeline, previous-record link, and recomputation of every evidence digest; a valid identity signature with stale/failing evidence must fail, while locally disabled switches cannot be raised by a valid record | fork/gap/conflict/stale/missing evidence or unavailable trust root derives `off-unverified`; local ceiling still wins |
| TUF control authenticity/current locator | threshold-pinned root, unexpired timestamp, persisted maximum metadata versions, snapshot and root-authorized top-level targets name the exact package hash, length, bundle head, and census root | this immutable control bundle is the current authentic artifact located by the installed TUF trust root; it does not by itself authorize local consume | TUF 1.0 threshold/expiry/rollback/freeze/consistent-snapshot checks plus publication-phase read-back and dist-tag-conflict, stale-timestamp, target-substitution, wrong-length, unauthorized-delegation, uncommitted-higher-version, and root/key-rotation controls; the independent freshness response must separately agree on every named TUF version and head | missing, expired, rolled-back, forked, mismatched, unavailable, or published-but-unactivated metadata disables consume; an npm dist-tag or valid package signature cannot substitute |
| release freshness | nonce-bound, unexpired response from the independent freshness key names current floor/head/rollback epoch and installed build | at issuance this command/floor matched the committed current head; the signed response is a lease accepted only until its bounded expiry | independent strongly consistent current-row CAS, request nonce, pinned role-separated key, trusted-time bounds, per-turn expiry, and fresh-host valid-old-bundle-after-rollback control; a local receipt is not corroboration | missing/stale/replayed/conflicted/unavailable response disables consume |
| emergency floor authenticity | strictly higher emergency epoch/head and exact off-only schema carry 2-of-3 signatures under the current root-authorized, custody-separated emergency role generation and live preemption marker | the freshness service may set a pending global off floor, strand the named in-progress candidate, then retain it as a satisfied replay minimum after H2; it certifies no positive authority | persisted role/epoch high-waters, TUF key records, host-verified exact floor and separate positive-health bodies from the independent endpoint, threshold/custody/domain/validity/revocation checks, marker-frozen exact-head CAS, atomic H2 satisfaction, and wrong-key, cross-role, old-generation, pre-lock/expired-marker, replay, signer-loss, compromise, and rotation controls; TUF/release/freshness/operator keys cannot substitute | reject the floor and never increase authority; missing/mismatched bodies fail positive consume off, while unavailable emergency-floor quorum makes no faster-off claim beyond the remaining current leases |
| global active-observe census | signed generation/digest/root and at most 64 private stable lease entries in `reserved | active | releasing`, with exact ring, command, target-token lineage, and lease expiry | this command does not raise the globally admitted observe population above 64 and this host owns one current active lease; it does not prove the host applied the command | protected pipeline's strongly consistent generation CAS, private stable keyed lease id, freshness-signed target leaf plus Merkle inclusion proof, per-pool aggregate union, signed off receipt or expiry-only release, and concurrent 63→64/64→65, renewal, key/membership rotation, duplicate, unreachable, crash-stage, and stale-CAS controls; public unlinkable token count is not corroboration | conflict, overflow, stale/missing census, reserved/releasing/expired lease, invalid proof, or unverifiable release keeps the target dark/off and leaves uncertain slots charged |
| pool/target admission | command salt plus continuity-keyed authenticated-pool commitment, host nonce, and enrolled machine key recompute the signed pool-scope and target tokens | this command was issued for this exact private pool and target enrollment without publishing stable identities | machine-signed enrollment request, CI-attested pool aggregate, wrong-pool/copied-nonce/duplicate-commitment controls, and local recomputation; possession of a public token alone is insufficient | pool/target mismatch or conflicting enrollment keeps host dark/off |
| control-fetch budget | host-wide rolling attempt rows, next-eligible/breaker, boot-aware monotonic and nondecreasing trusted wall high-water are below the closed limit | one bounded bundle/freshness fetch may start now; it does not certify rollout authority or freshness | transactionally inserted pre-I/O attempt plus build/ring/restart/clock-rollback/corruption N/N+1 controls; an empty or reset row is not evidence of budget | no fetch starts; consume remains off when freshness is unavailable |
| ring activation | current release floor plus contiguous release-signed promotion command/head, exact target-token/ring census, rollout/checkpoint, prior-config digest, current freshness response, and atomic local overlay | only this enrolled target host selected the named tuple within its local ceiling and current rollout authorization | fixed-host npm bundle, independent freshness response, persisted overlay high-water, signed pool receipt, and observe→rollback→old-observe plus crash-before/after-rename controls | stale/missing/conflicted/fetch-failed command, freshness, or overlay derives consume off; capture-only dark may continue when locally configured |
| fork resolution | immutable conflict set and closed resolution action plus distinct current security-reviewer/operator signatures under the release-pinned role registry | one exact branch may replace retain-off, or the compromised release role is revoked/re-keyed | incident-evidence digest, dual-role key separation/revocation state, conflicting-branch negative control, and operator/security disagreement fixture; release-issuer signature alone has no authority | retain off; checkpoint cannot summarize the fork |
| inbound replay admission | adapter's registered replay class plus authenticated cursor high-water or unified acknowledged-id set and origin serving epoch | this delivery is safe to enter the v2 canonical-evidence path exactly once on this serving holder | durable ingress row, lease-handoff cursor/ack state, signed reply marker, and old unordered-redelivery/foreign-epoch controls; delivery-id presence alone is insufficient | keep the adapter outside v2 and render the entire close visibly unverified; existing pre-v2 action behavior is unchanged |
| runnability | bounded real process canary on the exact binary/build | that build executed the fixture within the declared freshness window under the same bound identity/epochs | expected protocol event/result and process identity; binary presence alone is insufficient, while a temporary canary failure does not prove permanent absence | `never-observed | stale | unrunnable-fresh`; row ineligible |
| control/stream ownership | current signed canary over process group, PTY, action event, close, cancellation, and late-output suppression | launcher owns the response/action seam for that engine/build/host epoch | real action round-trip plus injected late/descendant output; a socket/file existing does not prove ownership, and a working seam with expired proof is not called current | `controlAvailability=unavailable` or `streamOwnership=missing|stale|failed`; visibly unverified freeform only |
| turn pinning/ordinal | signed turn binding names one origin; local durable ordinal advances exactly once before invocation; close machine equals origin | only the origin may execute or canonically close this logical turn, and this is its next bounded mediated action | local intent/CAS record plus wrong-machine, duplicate-ordinal, ownership-move, and partition controls; serving ownership elsewhere cannot continue the turn, while a reserved ordinal alone does not verify execution | reject continuation on another host; terminate old sink; affected old head remains partial/unknown; new host starts a new turn |
| continuity-key validity | pool binding and source/fragment authenticators verify under non-revoked enrolled generations | the named origin/producer signed this exact bounded record | current credential-store generation/revocation view plus wrong-key, rotated-key, and replay controls; a valid signature does not prove current enrollment, while revocation does not rewrite history as a different signer | local evidence remains local when possible; projection/action becomes `unknown`; rollout freezes on compromise |
| reconciliation mapping | immutable `pool_mappings` row binds a local terminal digest to one pool id after key recovery | this previously local-only head is now readable under that pool identity | original host signature, exact terminal digest, and conflicting-mapping negative control; key recovery alone does not prove identity, while a valid old local head without a mapping remains locally authoritative | remain local-only; remote read `unknown`; ambiguity quarantined |
| quota/capacity admission | origin, engine, session, byte, row, queue, and reserved-slot counters all remain below N | the recorder can accept this bounded candidate/head without evicting live evidence | transactionally charged counters plus N/N+1 and concurrent-contention controls; free disk alone does not prove admission, while a quota rejection does not disprove the action | candidate retained in memory when possible; clause `unknown` with `evidence-capacity`; no retry |
| action verdict | exact candidate/target/causality match and closed result | only the listed observed local action succeeded, failed, or is unknown | write-isolated authenticated report/native event or authoritative before/after state; successful tool prose can coexist with failed state, and valid state without matching causality remains unknown | clause `unknown`; never contradiction from absence |
| observed-mediated coverage | exhaustive registered+observed candidate manifest and closed denominator | percentage of action-bearing instrumented closes fully verified through the mediated seam | canonical engine census, unknown/unsupported sentinels, and unfavorable-row inclusion; 100% cannot certify hidden/bypassed actions and the fixed scope copy says so | `not-verified` when denominator/census is unavailable; low sample cannot yield a rate or positive label |
| calibration | closed outcome histogram on the exact worker/WAL/CAS path plus maximum-rate soak | that bounded path meets the declared latency/capacity floor under tested load | production-path samples and N/N+1 controls; a clean shadow run cannot erase failures, and a failure-heavy window does not prove code incorrect beyond the measured window | row ineligible/hold; no threshold widening |
| cross-machine projection | authenticated signed head fragments and contiguous schema revisions | what scrubbed evidence is readable from named source machines | source signature, key generation, origin/close equality, terminal digest, and contacted-machine list; unreachable/omitted peers do not prove absence, and local truth may exist before projection | response `partial`; remote clause unknown while local verdict is preserved |

No check above certifies global task completion, absence of hidden side effects, remote/provider
durability, or sandbox confinement. Tests pair every positive case with an impostor/control input
that must fail the claimed state.

## Bounded storage and multi-machine read

The existing `ClaimObservationRecorder` remains the sole projection facade and never decides a
verdict. It gains one bounded SQLite backend using the already installed `better-sqlite3`
dependency. A dedicated worker thread exclusively owns the connection, transactions, GC, and
calibrator. The server thread communicates through a 256-entry bounded `MessagePort` queue and
awaits promises; it never executes `better-sqlite3`, a busy wait, or `BEGIN IMMEDIATE` on the Node
event loop. Queue saturation preserves the in-memory candidate and yields `unknown` without
retrying the action.

All private persistence lives under `.instar/state/completion-evidence-private/`: `heads.sqlite`
plus its WAL/SHM/temp sidecars and `reports/`. The directory
is owner-only `0700`; every file is `0600`, opened without following symlinks, and ownership/mode
is rechecked before use. The implementation registers the exact prefix as a machine-local domain
in `WriteDomainRegistry`, excludes it from git/state sync, adds both project-relative and
stateDir-relative prefixes to `BackupManager.BLOCKED_PATH_PREFIXES`, and adds it to the hardcoded
`NEVER_SERVED_PREFIXES` used by file list/read/link/download/edit routes after realpath resolution.
No generic static-file, diagnostics, archive, cleanup, or dashboard route may traverse the prefix;
the versioned scrubbed endpoint below is the only read surface. `PostUpdateMigrator` creates and
repairs the directory without copying legacy transcripts into it. Migration, GC, backup, update,
case-folding, symlink, traversal, WAL/SHM, and report-file tests prove every deny and ownership
rule. A custody failure disables capture and produces `unknown`; it never falls back to a public
project path.

The backend schema is:

- `evidence_heads(evidence_id PRIMARY KEY, revision, engine, turn_origin_machine_id,
  close_machine_id, turn_hash, qualification_tuple_key_digest,
  qualification_candidate_digest, rollout_generation,
  projection_availability, pool_turn_id NULL, availability,
  terminal_digest, expires_at)`;
- `evidence_revisions(evidence_id, revision, envelope_blob, received_at,
  PRIMARY KEY(evidence_id, revision))`;
- `action_staging(evidence_id, action_id_hash, qualification_tuple_key_digest,
  qualification_candidate_digest, rollout_generation, seq, phase, fixed_blob, expires_at,
  PRIMARY KEY(evidence_id, action_id_hash, seq))`;
- `action_source_staging(evidence_id, action_id_hash, pool_action_id NULL, source_kind,
  source_digest, qualification_tuple_key_digest, qualification_candidate_digest,
  rollout_generation, producer_machine_id, producer_key_generation, auth_key_id, auth_signature,
  fixed_blob, expires_at,
  PRIMARY KEY(evidence_id, action_id_hash, source_kind))`;
- `report_reservations(evidence_id, action_id_hash, path_token, reserved_bytes, actual_bytes,
  expires_at, PRIMARY KEY(evidence_id, action_id_hash))`;
- `evidence_quarantine(event_uuid PRIMARY KEY, reason_code, scrubbed_digest, expires_at)`;
- `pool_mappings(local_evidence_id PRIMARY KEY, pool_turn_id, action_map_blob, terminal_digest,
  mapping_digest, signature_algorithm, signing_key_id, signature, reconciled_at,
  mapping_key_generation, expires_at)`;
- `reconciliation_state(source_machine_id PRIMARY KEY, cursor_captured_at, cursor_evidence_id,
  backlog_count, oldest_age_ms, breaker_until, updated_at)`;
- `promotion_receipts(command_digest, pool_scope_token, target_token,
  pool_continuity_key_generation, floor_digest, overlay_digest, applied_at, effective_mode,
  signature, expires_at, PRIMARY KEY(command_digest, target_token))`;
- `promotion_enrollment(singleton_id PRIMARY KEY CHECK(singleton_id=1), nonce_commitment, ring,
  build_digest, machine_key_generation, pool_continuity_key_generation, signature, updated_at)`;
- `control_poll_state(kind PRIMARY KEY, next_seq, consecutive_failures, next_eligible_at,
  breaker_until, max_wall_seen, last_boot_id, last_monotonic_at)`;
- `control_poll_attempts(kind, seq, ring, build, started_at_wall, boot_id,
  started_at_monotonic, wall_ms, outcome, PRIMARY KEY(kind, seq))`;
- `canary_state(dedupe_key_hash PRIMARY KEY, proof_identity_digest, window_started_at,
  baseline_attempted_at, retry_count, wall_ms, consecutive_failures, flap_count, last_outcome, next_eligible_at,
  breaker_until, updated_at)`;
- `canary_host_budget(bucket_utc PRIMARY KEY, baseline_count, baseline_wall_ms, retry_count,
  retry_wall_ms)`;
- `canary_audit(dedupe_key_hash, bucket_utc, fixed_outcome_counts, wall_ms,
  PRIMARY KEY(dedupe_key_hash, bucket_utc))`.
- `qualification_metric_buckets(host_id, qualification_tuple_key_digest,
  qualification_candidate_digest, reserved_or_final_rollout_generation, bucket_utc,
  fixed_counts, sample_count, PRIMARY KEY(host_id, qualification_tuple_key_digest,
  qualification_candidate_digest, bucket_utc))`.

Metric/calibration reduction reads the signed envelope identity, never the current executable,
config, or rollout head. A carried candidate plus two new reservations can create at most three
distinct sampled candidate digests in one UTC bucket. With 31-day retention and the separate
16-local-qualification-key limit, the adversarial maximum is `3 × 31 × 16 = 1,488` buckets. The
hard cap is 1,536 rows/1.5 MiB, transactionally charged inside the existing 32 MiB heads/index
component cap rather than added to the 384 MiB total; a candidate with no accepted sample creates
no bucket. Candidate change opens
a new key and old buckets cannot be merged. Row/byte N/N+1 fixtures include a sampled-then-stranded
carry-in plus both daily reservations across 1/16/17 local keys. Delayed reduction,
restart, old-head passive refresh, component update between intent/result/close,
same-key/different-candidate-or-generation, and missing/N-1 identity-field fixtures either charge
the original exact bucket or make the sample ineligible/unknown.

Before invocation, the writer appends immutable staging sequence 0 (`intent`); after execution it
appends sequence 1 (`result`). Each fixed staging blob is capped at 384 bytes. Source observations
are staged by action and capped at three 256-byte rows/action. Identity/phase mutation is rejected;
an identical append is idempotent. There are at most 15 actions × two staging events and three
sources/action per active turn.

A verifier report is at most 64 KiB and there is at most one report file per action and one active
report per turn. Before opening the owner-only no-follow file, the worker transactionally reserves
its full 64 KiB against a 64 KiB/turn, 128-file, and 8 MiB/host active-report cap. Short writes
release unused bytes exactly once. Immediately after that action result—and before another
report-producing action in the turn—the fixed parser verifies the content-addressed report and
persists only its signed scrubbed source outcome/digest in staging, then unlinks the raw file and
releases the reservation. Close reads that captured source record, never the raw report. A crash or
unlink failure makes the source unknown and leaves the charged orphan for GC; orphans expire after
ten minutes in bounded batches. At 64 concurrent turns the accepted active maximum is 64 files/
4 MiB; the 128-file/8 MiB hard cap provides N+1 headroom without contradicting the 64-turn soak.
No raw report survives normal per-action reduction or enters 30-day retention.

At close, one `BEGIN IMMEDIATE` transaction reads the closed staging/source rows, reduces every
action independently, writes terminal envelope revision 1, updates the materialized head, and
deletes the now-redundant action and source staging rows; the terminal envelope retains their
closed authenticated source arrays and signed action fragments. Revision 2 is reserved only for the single allowed
concurrent source reconcile/conflict transition before the displayed close commits. After display,
the head is immutable and late observations are audit counters only. A conflict on one action sets
only that action `availability=conflicted`; other actions cannot inherit its source/result.

A crash between intent/result leaves bounded staging for evidence reduction within the 24-hour
turn TTL, never automatic action re-invocation; closing without the result makes that action
unknown. Orphan staging expires after 24 hours in
bounded batches and never becomes a terminal verdict. Capacity failure retains the in-memory
candidate, marks its evidence unavailable, and does not invoke an unrecorded action. There is one
reload/reconcile attempt and no spin/retry on turn close.

Terminal heads remain immutable after display. Post-key-recovery reconciliation writes only an
immutable `pool_mappings` row; it neither mutates the terminal head nor consumes revision 2. An
identical mapping is idempotent, a different mapping quarantines the attempt, and pool reads join
the mapping only after signature/digest validation.

The canonical `action_map_blob` is capped at 1,152 bytes and contains the pool turn id plus at most
16 fixed `{localActionIdHash,poolActionId}` pairs in terminal order. Its origin signature covers the
local evidence id, exact terminal digest, full mapping blob/digest, key generation, and expiry.
Pool reads need no retained secret derivation material: they validate this blob and project the
stored action ids. Mapping blobs count inside the 32 MiB heads/index cap and cascade with the head.

Hard bounds per source machine:

- two terminal revisions per turn `evidenceId`, two staging events/action, and three staged
  sources/action;
- 10,000 live heads and 200 new heads/source-machine/UTC day;
- 20,000 quarantine rows and 600 new quarantine rows/UTC day;
- 256 MiB revision-blob cap, 4 MiB active-staging cap, 32 MiB heads/index cap, 16 MiB quarantine/
  aggregate cap, 8 MiB active reports, and 32 MiB WAL/temp cap inside a 384 MiB total footprint;
  256 queued writes;
- 64 canary-state rows, 31 host-budget rows, 1,984 canary-audit rows, 1 MiB total canary cap;
- 64 promotion-receipt rows/64 KiB, one 512-byte enrollment row, two control-poll state rows, and
  76 attempt rows/24 KiB;
- 30-day retention; bounded batch GC with source-row cascade;
- 250 ms background SQLite busy timeout, but close acquisition is capped at 100 ms and total close
  evaluation at 500 ms.

Canary admission and outcome update the per-key state and host budget in one worker transaction;
single-flight acquisition is a conditional update on `next_eligible_at/breaker_until`. Audit rows
aggregate fixed enums per UTC bucket, never one row per attempt. The 31-bucket GC cascades a key
only after its proof identity is no longer registered. N/N+1 keys/buckets/bytes, restart storms,
clock rollback, and concurrent triggers prove the persisted host-wide budget cannot reset or fork.

Head admission also caps each session at 32/day and each canonical engine at 80/day. Of the 200
machine slots, 24 are six non-borrowable four-head engine reserves and 176 are common; an engine's
first four heads charge its reserve, then the common bucket. Thus one session or engine cannot
exhaust every engine's ability to emit a diagnostic head. Quarantine admission similarly caps a
session at 64/day and an engine at 200/day, with six non-borrowable ten-row engine reserves inside
the 600 total. Exhausted sub-buckets are operator-visible and yield `evidence-capacity`; no hidden
priority or machine-id change resets them. Integration tests flood one and several
sessions/engines concurrently and prove the protected reserves and global ceilings.

The 200-heads-per-machine/32-heads-per-session daily values are provisional safe ceilings, not a claim that they fit
production demand. During dark qualification, each cohort records scrubbed
heads/session/day and heads/machine/day distributions for at least seven wall-clock days. Before
observe-only, both caps must be at least twice the measured p99 and above the maximum observed plus
25%, while the full 31-bucket footprint still passes its hard bound. If these fixed limits do not
meet that workload floor, the cohort cannot graduate; changing retention/caps/footprint requires a
reviewed spec revision. The 64-active-turn bound is a concurrency limit, not evidence of daily
throughput suitability.

UTC admission buckets are retained for 31 buckets (30-day retention plus one GC-lag bucket). At the
accepted maximum, `200 × 31 + 64 = 6,264`, below the 10,000 live-head cap. Two maximum 21 KiB
revisions for `200 × 31` terminal heads consume at most 254.3 MiB. The maximum 64 active turns add
at most 1.5 MiB of staging plus the independently enforced 8 MiB active-report cap. The component
caps total 348 MiB, leaving 36 MiB measured filesystem/index headroom inside 384 MiB. The row inequality is
`200 × 31 + 64 = 6,264`, below 10,000. Quarantine needs at most
`600 × 31 = 18,600` rows, below 20,000. Expiry returns row/byte quota exactly once; unexpired rows
are never evicted.

Overflow, disk full, busy timeout, revision/cardinality ceiling, or queue pressure never evicts
live evidence or fabricates a verdict. Affected clauses become `unknown`, reason
`evidence-capacity`; the action itself is not retried.

Canonical CBOR encoding uses integer field keys, fixed binary handles/hashes/tags/signatures,
one-byte enums, bounded integers, a 1,096-byte top-level allowance (including three producer-key
certificates and the exact qualification identity), and at most 1,224 encoded bytes/action including
the repeated qualification identity and six per-clause basis enums. Sixteen fully populated entries therefore
fit within `1,096 + 16 × 1,224 = 20,680` bytes, below 21 KiB. Bounds fixtures fill every optional field and reject
the next byte before allocation.

Integration admission includes a calendar-accelerated deterministic 31-bucket sustained
maximum-rate soak using the production clock-injection seam, maximum-size envelopes,
two revisions, 64 concurrent maximum-action turns, one-bucket GC lag, row/byte N/N+1 attempts, and
maximum quarantine traffic and active report churn/orphan cleanup. It records actual allocated
report/page/index/WAL/temp high-water marks and rejects admission if any dedicated cap or the
384 MiB footprint would be exceeded.
The accelerated soak proves bucket/GC arithmetic; it does not replace the seven-day development
and fourteen-day fleet wall-clock windows or their real latency/workload samples.

The same soak runs worker GC and calibration concurrently while measuring server event-loop p99
lag and unrelated user-response p99 latency. Admission requires p99 loop lag ≤20 ms and no more
than 50 ms added p99 sink latency at 64 active turns. Deadline, worker crash, and a wedged SQLite
lock all yield `unknown` within the 500 ms close ceiling while unrelated replies remain live.

This action-evidence store is a bounded per-entity revision projection, not an action
workflow/outbox engine: it has no provider
callbacks, dispatch, retries, tombstones, consumer offsets, unbounded replay, or independent
reducers. Process Health and pool/audit are versioned reads of materialized heads, not reducers.
OpenTelemetry remains an optional allowlisted export vocabulary; it is not verdict authority.

Alternatives were evaluated against this local-only requirement:

| Pattern | Benefit | Why not chosen / reopen trigger |
|---|---|---|
| single-machine evidence with no pool projection | smallest initial implementation | allowed only for the dark test-agent seed; rejected for a positive surface because serving ownership can move and a machine-local-only history would silently strand the user's read. V1 keeps in-flight work machine-pinned but uses the existing bounded recorder facade for post-close proxied reads. |
| existing recorder + bounded revisions | reuses current trust/storage owner; exact per-entity CAS and bounded reads | chosen for one local reducer and no dispatch/retry/callback |
| restricted append-only event log + materialized head | standard replay and audit ordering | adds consumer offsets, replay authorization, compaction, and a head for no current independent consumer; reopen for a second reducer or historical recomputation |
| transactional outbox / durable workflow | mature dispatch, callback, retry, settlement | those capabilities serve provider/async effects that are out of scope; reopen with provider dispatch, post-turn settlement, or action retries |
| strict OpenTelemetry pipeline | standard trace context and tooling | telemetry status/attributes do not define action-specific causal truth and exporters enlarge the privacy surface; reuse only its trace vocabulary |
| in-toto/SLSA-style attestation | standard signed artifact provenance | optimized for supply-chain subjects/predicates, not bounded interactive turn/action capture or local sink control; reconsider for build-artifact export, not turn verdict storage |

Control distribution separately chooses standard secure-update machinery:

| Pattern | Decision |
|---|---|
| TUF 1.0 root/timestamp/snapshot/top-level targets | **chosen** for bundle authenticity, length/hash binding, key rotation, consistent snapshots, and rollback/freeze protection; V1 deliberately avoids delegations, and domain rollout/floor fields remain a target payload because TUF does not evaluate engine qualification or local admission |
| minimal signed feature flag + TUF expiry | rejected for positive authority: it authenticates requested mode and package age but cannot bind the full cohort fixture digest, targeted host inclusion, active-census ceiling, independently current emergency floor/health body, or atomic cross-pool promotion; it is sufficient only as the local shrink-only ceiling |
| Uptane Director/Image repositories | not chosen wholesale: V1 has no vehicle/ECU primary-secondary inventory, and private pool receipts plus local config ceilings do not map to ECU install reports; the command's pool/target tokens borrow director-style targeting without adopting an unused vehicle workflow |
| existing feature-flag/rollout service | not authority-capable: current config distribution has no signed exact-byte lineage, offline rollback floor, per-target inclusion proof, or fail-off freshness; it remains the local requested-mode ceiling, never the positive source |
| general durable workflow engine | capable of hosting the publication phases, but not chosen for V1: it would still require the same signed domain states, immutable intents, HSM boundaries, exact-byte read-backs, and recovery fixtures while adding a new availability/replay authority; the bounded single-flight coordinators use the existing SQLite/CAS foundation and must pass the enumerated crash matrix. Reopen if a second control workflow needs shared scheduling/history or the bounded coordinator exceeds its fixed states |
| general lease service | not chosen for V1: public/shared lease identity would enlarge the privacy and trust surface; the private stable host commitment, signed census root, and fixed 64-target ceiling are domain requirements, not scheduler placement |
| transparency log | useful for public append history but insufficient for current authorization, targeted privacy, emergency reduction, or bounded offline replay; the signed hash-linked audit remains private in V1, and a public log is reconsidered only if third-party verification becomes a requirement |
| Sigstore/Rekor transparency | useful future public audit for release-bundle digests, but identity/transparency does not authorize a ring, supply current private-pool targeting, or provide local replay/config semantics; it cannot replace TUF or the evidence contract |

Implementation may split the design into six child workstreams—local protocol, engine adapters,
replay admission, storage/projection, rollout publication, and emergency control—before code lands.
Each child must cite this parent, preserve its exact interface digests and failure direction, and
converge independently; no child can approve positive activation alone. The parent remains the
normative cross-plane authority precisely so interface changes cannot create partial activation.

The custom evidence protocol is smaller in behavior, even though its contract is detailed. It adds one
closed envelope/codec, one deterministic verifier/renderer, one bounded recorder worker, and one
read-only pool merge. Signatures, candidate completeness, output ownership, and action-specific
predicates are required under every storage choice; an event log or attestation library would not
remove them. Those alternatives additionally require event ordering, replay/consumer ownership,
checkpoint compatibility, compaction, exporter policy, or a second materialized reducer. V1 has
none of those: no consumer offsets, callbacks, dispatch, action retry, tombstone workflow, exported
attestation, or historical recomputation. The implementation review rejects any build that grows
beyond these four runtime responsibilities; that is the reopen trigger for a standard log/workflow
foundation.

The chosen HMAC-identity/Ed25519-fragment envelope is an internal strict provenance profile: its
closed schema, local keys, 21 KiB cap, and no exporter are intentional. A requirement for a second independent consumer,
historical recomputation, async settlement/retries, provider dispatch, or exported build
attestations reopens the architecture decision.

Raw evidence stays machine-local. The authenticated pool read projects only scrubbed heads,
pool turn/action ids, source-machine id/key generation, revisions, verdicts, and basis. Highest contiguous valid revision wins;
conflicting terminal digests remain `unknown`. The projection is backup-excluded because host-keyed
evidence cannot be restored as local authority. Restore starts empty; recent pool projections remain
readable only from other still-enrolled source machines. Historical heads whose sole source was the
restored-empty host are unavailable; the design has no replica/cache and does not claim otherwise.
New local canaries and evidence rebuild authority; during recovery the normal precedence yields
`coverage=not-verified` until a row is readmitted, with diagnostic reason
`cold-start-after-restore`. Process Health names the unavailable historical source rather than
showing an empty successful history.

The read surface is a new versioned
`GET /completion-evidence/heads?scope=local|pool&schema=1&limit=N&cursor=C` route; the existing
completion-claim audit route is not reused because it exposes a different aggregate. Local pages
cap at 200 heads/256 KiB. A pool page fans out to at most 16 enrolled machines, clamps each peer to
64 heads/128 KiB, uses a 750 ms peer deadline and 2 s total deadline, and caps the merged response
at 512 KiB with a signed continuation cursor. The pool coordinator sends only authenticated
`scope=local` subrequests with `X-Instar-Pool-Hop: 1`; a peer rejects `scope=pool` or any nonzero
incoming hop from a peer, so fanout cannot recurse. More than 16 machines are paged deterministically by
machine id; they are never silently omitted. The cursor binds schema, filter, ordered machine ids,
their enrollment-census generation, and per-machine cursors. A membership-generation change
returns `409 cursor-census-changed` and requires a fresh page rather than skipping an inserted peer.

Each response declares `complete | partial | conflicted`, contacted/unreachable/omitted machine ids,
peer schema versions, and per-machine cursors. N readers accept N and N-1 schemas during expand;
an older peer contributes only fields it can authenticate, and an unknown/newer schema is reported
partial rather than coerced. Duplicate pool turn/action ids dedupe only when source signatures and
terminal digests agree; disagreement is `conflicted`/`unknown`. An unreachable or unpaged peer is
absence of evidence, never proof that no action occurred. Integration tests cover N/N-1, a newer
peer, offline/rejoin, cursor replay, duplicate delivery, conflict, byte/time clamps, and the
reconciled visibility of a formerly local-only head on machine B.

## Multi-machine posture

| Surface | Posture | Mechanism and reason |
|---|---|---|
| live process/PTY/control proof and raw action/report evidence | `machine-local` | authority depends on the physical process, host kernel, boot/install epoch, and local state being verified; only scrubbed signed fragments leave the host |
| host signing/cursor-HMAC keys and single-turn control capabilities | `machine-local` | credentials remain in the platform credential store/isolated supervisor and are never replicated as data |
| host enrollment nonce | `machine-local` | it is an owner-only capability bound to the non-exported platform machine key; only its signed commitment leaves the host |
| control-fetch attempt/breaker state | `machine-local` | its counters bind the exact target host's monotonic clock, network attempts, and local resource brake; receipts expose outcome, never transferable budget authority |
| in-flight turn ownership and action ordinal | `machine-local` | V1 pins the whole turn to its origin; routing ownership movement terminates that close path and another host must start a new logical turn |
| scrubbed evidence heads and reconciled local-only mappings | `proxied-on-read` | versioned `/completion-evidence/heads?scope=pool` fanout/merge above; source and evidence basis are preserved |
| engine census, coverage registry, rollout generation, maturation state | `unified` | canonical git-tracked engine registry plus signed append-only rollout records carried by HLC union; same-generation conflict fails closed and no per-machine record can waive global qualification |
| release floor, freshness, promotion commands, and per-target activation receipts | `unified` | one release-signed immutable npm control bundle carries commands, the independent nonce-bound current-head service proves freshness, each target's atomic overlay stores a digest-bound verified shard of its signed parent command, and scrubbed signed receipts make application visible to the exact next-ring census |
| inbound custody/dedupe and action-bearing reply markers | `unified` | `MessageProcessingLedger` is the origin write-ahead shard; `ReplyMarkerTransport` carries its monotonic signed state to serving peers, while adapters without an authenticated ordered cursor or unified acknowledged-id set are canonical-evidence-ineligible but keep pre-v2 action behavior |
| Process Health display | `proxied-on-read` | serving-lease holder reads the bounded pool endpoint and shows partial/conflict state explicitly |
| user notices and generated URLs | `unified` / none | this observe-only feature creates no notice and no URL; ordinary evidence is rendered once by the current serving holder |

machine-local-justification: hardware-bound-resource

The marker above applies to live process/PTY/control proof, the in-flight turn boundary, raw
action/report evidence, and control-fetch attempt/breaker state: those facts, the host monotonic
clock/resource budget, and the owned process are inseparable from the physical machine whose state
they certify. A completed scrubbed projection is the cross-machine continuity path;
V1 does not claim transparent movement of a running process.

machine-local-justification: physical-credential-locality

The marker above applies only to host signing/cursor-HMAC keys, the key-bound enrollment nonce, and one-turn
control capabilities. Keys/nonces are not replicated; the pool sees signed commitments and scrubbed
projections. Availability is never used as a locality
justification: after key recovery the bounded reconciliation path makes eligible scrubbed heads
visible pool-wide without moving raw authority.

## Qualification candidate handshake

Measurement never predicts or circularly depends on a final rollout generation. The protected
release pipeline owns one strongly consistent `CompletionEvidenceQualificationCandidateStateV1`
with monotonic candidate sequence and states
`idle | reserved-dark | measured | finalize-intent | finalized | expired | stranded`.
A reserve CAS from `idle` binds the exact current rollout predecessor generation/digest, the next
rollout generation, complete qualification tuple set/reference flags, all fixture/CLASS/component
artifact digests, issue time, and ten-day expiry. It emits an at-most-24-KiB release-signed
`CompletionEvidenceQualificationCandidateV1` under a distinct
`instar/ce/qualification-candidate/v1` domain with `authorizedMode=dark-only`. The signed candidate
can authorize only measurement capture; it can never satisfy rollout, promotion, freshness, or
user-visible admission.

Hosts key every dark calibration/metric event by
`{host, qualificationTupleKey, qualificationCandidateDigest}` and carry the candidate's reserved
rollout generation as signed provenance. Seven-day measurement changes the same durable candidate
to `measured` only after the exact per-key artifacts and denominators pass. Finalization first
persists `finalize-intent` with the exact candidate/record bytes, then idempotently signs/appends
one `CompletionEvidenceRolloutRecord` whose generation, predecessor, tuple set, artifacts, and
`qualificationCandidateDigest` are byte-identical to the reservation. The final CAS marks that
candidate `finalized`; response loss resumes the same intent and no sibling record may be minted.
This candidate→final-record binding is the sole permitted measurement transfer. No later
candidate/generation may reuse its samples.

Only one candidate may be `reserved-dark | measured | finalize-intent`; reservations are capped at
two per rolling 24 hours. Expiry, an intervening rollout/emergency predecessor, tuple/artifact
change, or signature/storage conflict makes it `expired | stranded`, keeps consume off, and burns
the candidate sequence; a new candidate gets a new digest and fresh seven-day windows. Before any
sample, an operator-approved cancellation may return to idle while still burning the sequence;
after the first sample only expiry/stranding/finalization is permitted. A separate
`completion-evidence-qualification-candidate` replicated kind carries at most 64 immutable
24-KiB candidate records for 31 days under the same release public key; it is registered in
`CoherenceJournal.JOURNAL_KINDS`, retention, `ReplicatedKindRegistry`, and exactly one consumer,
conflict-preserving HLC union, and a 4 MiB file cap. Reserve/finalize crash points, concurrent
reserve/finalize, predecessor change, expiry at day 6/7/10, cancel-before/after-sample, response
loss, duplicate append, 1/64/65 records, and old-candidate replay all fail dark or resume the exact
intent without transferring evidence.

## Admission measurements

Development seed deadlines have no production authority. Before an exact
`{host, qualificationTupleKey, qualificationCandidateDigest}` becomes eligible, dark capture runs the exact
WAL/CAS/schema path for seven consecutive days at the intended workload.
The expected maximum is 16 candidate entries/turn (15 executable plus the overflow sentinel) and
64 concurrent turns.

Admission requires, per concurrency tier 1/16/64:

- at least 10,000 attempts total and 1,000/tier;
- closed outcomes `committed | deadline | busy | queue | capacity | error`;
- ≥99% successful durable capture;
- measured p99 result durability ≤100 ms;
- measured p99 close database acquisition ≤100 ms;
- measured p99 total close evaluation ≤500 ms.

The isolated calibrator uses a synthetic quota namespace capped at 700 turn heads and 24 MiB/run.
It packs at least 10,000 action updates into at most 667 heads (15 actions/head) while exercising
the identical staging, envelope reduction, CAS, queue, deadline, and byte-accounting code.
Synthetic heads never
consume production rows/bytes/metrics or project to the pool. Separate N/N+1 fixtures run the
production 200/day, 10,000-live, component byte caps, and concurrency limits, so isolation cannot skip quota
logic. The minimum sample is therefore achievable inside the seven-day qualification window.

The authenticated qualification candidate and its byte-identical final rollout generation record
the exact qualification tuple key/candidate digest, sample count,
workload tier, p50/p95/p99, component hashes, issue time, and eight-day expiry. Any tuple-key change
or candidate-digest change starts a new seven-day window; samples and eligibility never transfer
between near-match keys or candidates. Process Health displays coarse buckets and reason. An expired or failed calibration makes only the affected tuple ineligible; it does not widen deadlines
or block unrelated actions. Operators may lower concurrency within the measured tier. Raising a
hard latency ceiling or weakening the success floor requires a new reviewed spec.

Calibration uses an isolated ≤64 MiB database on the same storage path, ≤10% duty cycle, and yields
within 100 ms to production traffic. Sufficient passive production samples may refresh the same
closed histogram. Failure-heavy samples cannot be discarded or replaced by a clean shadow run.

## Metrics and rollout

Metrics are keyed only by `host + CompletionEvidenceQualificationTupleKeyV1 + qualification-candidate-digest`;
the action row is already inside the canonical key. Aggregation may expose a fleet view but cannot
qualify or hide a failing exact tuple. Over a rolling seven-day window for each locally activating
exact tuple:

1. **Eligible-row performance**
   - capture success = candidates with complete matching terminal evidence / canonical candidates
     on eligible rows, target ≥99%;
   - unknown rate = unknown / canonical candidates on eligible rows, target <5%.
2. **Instrumented-turn coverage**
   - numerator = action-bearing instrumented closes whose complete mediated candidate set is canonical and
     every candidate row is eligible;
   - denominator = every action-bearing instrumented close, including freeform, missing, invalid,
     unknown, and unsupported candidates;
   - target ≥95%; every observed unsupported/unknown action remains separately counted.

These metrics say nothing about uninstrumented or hidden actions. They cannot produce a “broad
completion” label.

Each rate has its own minimum denominator of 100 action-bearing closes and 1,000 candidates per
host+qualification-key+candidate window. A metric below either minimum is `insufficient-sample`; it freezes advancement and
renewal exactly like an unavailable metric and cannot be omitted from the cohort decision.

One threshold-breaching window marks the exact tuple `degraded` as a diagnostic reason and freezes
rollout advancement. Two consecutive windows below capture/unknown/coverage targets prevent
renewal of that tuple's eight-day admission artifact, making it ineligible in the next generation.
Any favorable-scope omission, registry shrink without reviewed migration, or integrity conflict
freezes the generation immediately. Unsupported/unknown candidates remain explicit counts and
force engine `coverage=partial-observed-mediated-local-verification`; they cannot be normalized
away by an observe-only posture. Fewer than 100 action-bearing closes or 1,000 candidates is
`insufficient-sample` and cannot produce a rate, renewal, or positive label; the row remains ineligible/held without an
operator notice.

A/B same-host keys that differ only in executable, adapter, component bundle, OS/runtime,
schema, or renderer generation maintain separate windows, artifacts, degraded states, and renewal
decisions. Near-match, swap-mid-window, rollback, and same-generation dual-key fixtures prove no
sample, denominator, or eligibility pooling; a new candidate digest also starts empty windows.

Rollout:

1. **Shared dark seed:** build protocol/store/renderer around Instar-native `test-run`; no engine,
   including native, may display a positive verdict.
2. **All-engine dark rows:** build and live-probe one real `test-run` action/control/close row for
   Claude Code, Codex CLI, Gemini CLI, pi CLI, and Grok Build. Each engine keeps separate results.
3. **Cohort dry-run:** run the same real fixture/failure corpus and seven-day calibration on all six
   engines. Missing, ineligible, or insufficient-sample rows hold the whole activation generation.
4. **Generation observe-only:** one signed rollout record authorizes `observe-only-parity` only when
   the canonical engine census exactly equals the globally qualified cohort. Each updated host then
   admits only its locally enabled/runnable engine tuples; absent vendor credentials do not block
   that host, and no engine pools metrics with another.
5. **Optimized row expansion:** add build/file/registered-command rows per engine behind separate
   dark/dry gates; an optimized row never reduces the common `test-run` floor.
6. **Blocking:** separate operator-ratified spec using measured false-positive/negative evidence.

The total precedence matrix above governs both kill switches. Disabling consumption leaves scrubbed
rows inert and can derive only dark/off; disabling capture derives off. Rollback appends a higher
signed off generation rather than mutating or pinning an ambiguous prior record. No step rewrites
engine-owned artifacts.

## Maturation plan

- **test-agent-live:** On throwaway agent homes, run the shared dark seed and then every canonical
  engine's real `test-run` control/action/close fixture, including channel-bypass, forged-source,
  wrong-host continuation, newer/older schema, worker-wedge, and synthetic-engine negative controls.
  No user-visible positive evidence is enabled at this rung.
- **dev-agent-live:** Register the feature in the maturation tracker as
  `cross-engine-completion-evidence`, keep `completionEvidence.requestedMode=dark-parity`, and run at least
  seven consecutive days across the qualification hosts for every engine and on the development
  agent for each engine locally enabled there. The test owner validates
  fixture truth; an independent reviewer adjudicates false positive/negative samples; the serving
  agent verifies the real channel cannot bypass canonical close. After that evidence is signed into
  an observe-authorizing rollout record, the dev ring-promotion artifact sets requested observe and
  both switches true for the dev observe window.
- **fleet:** bounded V1 cohort — production-ring config remains `off-unverified` by default. After the graduation criterion is
  satisfied, deploy the same exact cohort generation first to development agents, then to a bounded
  production canary cohort, and only then to the globally capped 64-host V1 cohort. Each step uses its signed ring-promotion artifact;
  no host remains at default off merely because the rollout record exists. A machine missing a row for an engine enabled or
  observed locally remains `off-unverified`; absence of an unused vendor engine does not block it.
- **graduation criterion:** Every canonical engine plus Instar-native has at least one globally
  qualified reference tuple; every locally activating host+qualification-key tuple has current control/
  stream proof, real positive and negative `test-run` fixtures, ≥10,000 calibration action attempts
  with every per-tier minimum, ≥100 action-bearing closes and ≥1,000 candidates per seven-day window,
  ≥99% capture, <5% unknown on eligible rows,
  ≥95% observed-mediated coverage, zero channel bypasses, zero forged-source acceptances, zero
  accepted wrong-host continuations, p99 event-loop lag ≤20 ms, ≤50 ms added p99 reply latency, successful
  N/N-1 pool reads and local-only reconciliation, freshness-service 64/65-host capacity/burst/
  overload recovery with ≥25% headroom, a signed global active-host census ≤64, and two consecutive independent review rounds
  with zero DESIGN findings on the exact body/generation.
- **dark-window:** Minimum seven consecutive days and at least one restart, reinstall, continuity-key
  outage/recovery, offline origin/rejoin with remote pool read, worker crash, and storage-pressure episode before
  dev-agent observe-only; minimum fourteen additional days in the bounded fleet canary before the
  fleet proposal. A missed window or stale evidence holds the feature dark and keeps the maturation
  item open.

Named kill switches are `completionEvidence.captureEnabled` and
`completionEvidence.consumeEnabled`; both default false outside the registered maturation rung and
resolve through the same config loader the hook/renderer consumes. Ship-time registration, config
defaults, built-in skill/gate updates, existing-agent `PostUpdateMigrator` changes, database schema
creation, backup exclusion, the full mechanism inventory/bounded historical-backlog artifact/check,
and downgrade fixtures land in the same implementation PR. Every new/modified candidate is covered
immediately; legacy-unverified candidates follow the owner/due/zero-backlog lifecycle above and are
never presented as already covered. The global gate's own migration test installs an old agent, updates it, and proves
the new spec-converge and `assertFrameworkGenerality` artifacts/checks are present and active.

## CI and testing

### Unit

- closed schema, bounds-before-allocation, dangerous keys, Unicode normalization, scrub boundary;
- HMAC domain separation, turn/action binding, replay, collision, key rotation/destruction;
- exact target/action matching; wrong target, prior state, concurrent writer, stale report;
- `verified | contradicted | unknown` mappings with prose/model diagnostics disabled;
- canonical/freeform/missing/invalid closes; candidate digest; idempotent/divergent repeat;
- unsupported/unknown candidate sentinels; pre-action in-memory registration; durable-intent
  failure; 15 actions plus overflow sentinel; rejected 16th and bounded further attempts;
- canonical schema-version-0/no-target hashes for unsupported, unknown, and overflow sentinels;
- 50/100/500 ms action-time enqueue/result/cumulative evidence budgets;
- escaped commentary against Markdown, ANSI, bidi, HTML, forged headings, and badge spoofing;
- CAS merge/conflict, quotas, expiry, GC cascade, disk full, busy timeout, queue pressure.
- canonical-CBOR maximum field lengths and 21 KiB rejection-before-allocation.

### Integration

- coverage registry has a row/corpus for every build-supported engine;
- exhaustive engine/build manifest unions registry+observed rows; favorable-scope omission,
  unknown-row arrival, unauthorized shrink, and signed rollout-generation conflict force partial/freeze;
- seed supervisor/report producers fail independently and disagreement stays unknown;
- each engine/action primary and redundancy pair passes producer/store fault injection;
- real storage calibration at concurrency 1/16/64 with closed denominators;
- 15-action sequential/interleaved staging with three sources/action; crash between intent/result;
  per-action source disagreement; terminal reduction deletes staging and does not contaminate
  unaffected actions;
- isolated 10,000-update calibration completes within its 700-head/24 MiB namespace while
  production row/byte limits are separately enforced;
- N/N-1 schema expand/contract, rollback, restore/cold start, key rotation;
- pool read preserves source/basis and conflict without raw evidence; peer `scope=pool` recursion is
  rejected and a membership-generation change invalidates the cursor;
- producer/public-key history, offline rotation/revocation, and unknown-key failure to unknown;
- local-only reconciliation drains a 6,200-head backlog across repeated 200-head ticks with durable
  cursor restart, production-write priority, per-head quarantine, and breaker recovery;
- raw report N/N+1 bytes/files, per-action unlink, orphan GC, and filesystem allocated-byte accounting;
- requested-mode/kill-switch Cartesian matrix, mixed peer generations, same-generation rollout
  conflict, offline lower-generation rejoin, and migration/downgrade to off-unverified;
- Process Health derives coverage only from the closed precedence table.

### End to end

- one real fixture per admitted engine/action renders the same semantic evidence block;
- normal/late stdout/stderr, hung child, descendant output, cancel/TERM/KILL, resize, restart,
  reinstall, and stale proof;
- prompt-injected omission cannot remove launcher-derived candidates;
- freeform cannot spoof or reorder launcher UI; no proof means no evidence block;
- concurrent/resumed/nested calls, retries, out-of-order/dropped results, background and prior-turn
  bleed use signed identities, never timestamp joins;
- machine A execution/read on B, offline/rejoin, duplicate replay, and conflicting terminal data;
- signed pool-stable turn/action mapping across machine-B projection; wrong-turn, wrong-source-machine,
  wrong-key-generation, timestamp/text/target spoof joins rejected;
- continuity-key unavailable preserves local verdict with `local-only` projection; nullable pool
  ids never leave the host;
- all capacity failures reach immutable clause unknown without retry or silent allow.
- 31-day sustained maximum-rate/maximum-envelope soak, one-bucket GC lag, and row/byte/quarantine
  N/N+1 prove the accepted rate cannot self-exhaust.

## Frontloaded Decisions

- V1 covers instrumented deterministic local actions only.
- The engine census is derived exhaustively from canonical `SUPPORTED_FRAMEWORKS` plus
  `instar-native`; no hand-maintained subset defines cross-engine completion.
- Positive observe freshness is deliberately co-authorized by a root-pinned 2-of-3 quorum of
  independently administered online HSM/service principals; it may continue only the exact current
  head, while a separate 2-of-3 emergency role remains reduction-only.
- Dark seed work may proceed per engine, but the first positive user-visible generation activates
  only from a signed generation that globally qualifies the full canonical engine cohort plus a
  contiguous signed global promotion snapshot containing the local host's exact pool/ring group.
- The global framework-generality process gate requires a generated per-engine evidence artifact
  for every future agent-general mechanism, not only this subsystem.
- `observe-only-parity` retires the Claude transcript/no-op verifier path on every updated process; after cutover,
  rollback means `off-unverified`, never restored Claude privilege.
- The launcher derives and renders every mediated action candidate; the model cannot choose the
  verified claim set.
- Mediated candidate completeness includes unsupported/unknown sentinels before schema lookup and
  cannot be narrowed by rollout configuration.
- No LLM/prose judgment has runtime authority.
- Standalone sessions and out-of-scope actions receive unknown, never silent no-op.
- An inbound adapter without ordered-cursor or unified-ack proof keeps its existing action behavior
  but cannot enter the canonical-evidence path; current Slack therefore remains visibly unverified
  until its acknowledged-id foundation exists.
- Only `test-run`, `build-run`, causal `file-write`, and execution-only `local-command` schemas exist.
- Durable external receipts, async settlement, workflow/outbox machinery, and broad confinement are
  separate future specs, not open choices here.
- Every admitted engine/action row requires a real fixture and fault-tested deterministic
  redundancy.
- Local verification basis is disclosed; no local pair is described as host-independent.
- Canonical output requires current host-local stream ownership and non-spoofable rendering.
- Canonical output also requires channel isolation; a direct user-channel bypass attempt is refused
  before delivery or makes stream ownership unavailable.
- Evidence is scrubbed, bounded, host-keyed, backup-excluded, and projected cross-machine only in
  closed form.
- V1 observe activation is globally capped at 64 target hosts across every agent pool/ring; host 65
  remains dark until a later capacity spec and measured freshness-service expansion.
- The existing recorder plus bounded revisions is the chosen single-reducer projection; async
  settlement/retries, a second reducer, historical recomputation, provider dispatch, or exported
  build attestations reopen that choice.
- Unknown never means verified; absence never means contradicted.
- Rollout is observe-only; verdict-based blocking requires a separate operator decision, while
  action registration, channel isolation, capacity, and the machine-pinned turn boundary remain deterministic
  safety preconditions.

## Decision points touched

- `mediated candidate completeness` — **invariant**: every mediated intent enters the bounded in-memory set before invocation, including unsupported/unknown sentinels; persistence failure retains an unknown candidate, overflow rejects before execution, and model/config cannot alter or scope candidates away; this does not claim unmediated task completeness.
- `canonical close` — **invariant**: exactly one digest-bound close; arbitrary prose is forbidden; missing/invalid/late close makes affected clauses unknown.
- `freeform presentation` — **invariant**: commentary is structurally isolated, escaped, visibly unverified, and cannot receive a clause verdict.
- `engine census` — **invariant**: compiler-exhaustive canonical framework union plus explicit `instar-native`; an unrepresented engine fails the artifact and generation.
- `stream admission floor` — **invariant**: `controlAvailability=current` and current engine/build/host proof own process group, PTY, stdout/stderr, channel isolation, control seam, cancellation, ordering, and final sink; any missing proof yields freeform only.
- `verifier/schema sufficiency` — **judgment-candidate**: the pre-build design floor requires exact predicates, write-isolated corroboration architecture, executable positive/negative fixture definitions, and complete provenance fields; spec-converge security+integration reviewers are the arbiter, with a second external-family review on disagreement; unavailable/degraded review or unresolved disagreement ends at `uncharacterized`.
- `operational row eligibility` — **invariant**: after a schema is reviewed, exact current signed fixture outcomes, host/build stream proof, calibration/provenance artifacts, freshness, and local enablement deterministically derive `eligible | uncharacterized | unsupported-for-verification`; missing/expired/conflicted evidence makes the row ineligible without a new design judgment.
- `rollout graduation` — **judgment-candidate**: deterministic floor requires global qualification for every canonical engine plus local admission for every enabled host tuple, all numeric graduation criteria, exact-body hashes, and a signed generation; the independent maturation reviewer is the arbiter, with operator approval required only for a later blocking mode; unavailable evidence, partial cohort, or reviewer disagreement ends deterministically at `hold`.
- `registry shrink/removal` — **judgment-candidate**: bounded action space is `approve reviewed migration | deny`; the framework-generality reviewer must prove the canonical engine is removed or the mechanism is no longer agent-general, and a failed/unavailable review deterministically denies the shrink.
- `generation cutover` — **invariant**: after signed eligibility/graduation inputs exist, one whole-cohort signed rollout record authorizes a maximum, and only a current contiguous signed global promotion snapshot plus an atomic locally verified shard lets a targeted updated process derive observe-only; no per-engine record or legacy fallback exists.
- `promotion applicability` — **invariant**: an ordinary epoch is a bounded complete snapshot of every active pool/ring group and ≤64 total target leases; a host selects the newest non-expired snapshot containing both its recomputed pool and target tokens unless a newer global emergency-off exists, and omission of any previously active unexpired lease fails command preparation. `refresh-only` preserves lease set, authority tuple/epoch, window start/evidence, rollout, and prior config; any addition or raise is `authority-increase` and waits for the prior window, while reductions/emergency-off remain immediate.
- `TUF control locator` — **invariant**: the threshold-pinned TUF 1.0 chain is the sole current locator for the immutable npm control target and binds its exact hash, length, and head; the dist-tag is only a hint, custom completion-evidence signature domains do not wrap TUF metadata, and any expiry/version/head disagreement disables consume.
- `TUF timestamp renewal` — **invariant**: a separate bounded single-writer transaction rotates only monotonically versioned timestamp metadata over the unchanged snapshot/head, signs late with at least 50 minutes remaining, publishes before its freshness CAS, and permits only a higher timestamp version—not a command sibling—after expiry; emergency rollback can atomically absorb an already-published refresh while raising the off floor.
- `control publication transaction` — **invariant**: a durable single-writer prepare row fixes the candidate census, command, package, and TUF versions/bytes before any signature or external write; phase publications are digest-idempotent, the final freshness CAS alone activates, and ordinary crash recovery finishes the same candidate rather than minting a sibling.
- `emergency off preemption` — **invariant**: a marker-frozen, physically reserved 2-of-3 reduction-only role under the root-authorized emergency key record is the sole arbiter for a signed floor CAS; pending disables consume independently of any stuck ordinary/TUF/timestamp writer, cancels an unsigned ordinary candidate, permanently strands a signed or possibly published one, and makes the bounded emergency command its linear descendant. H2 atomically satisfies but never erases the replay floor; only a newly qualified H3 authority-increase can restore observe. The distinct online 2-of-3 positive-health role co-authorizes only continued freshness for the exact current head, with lease expiry clamped to its ≤60-minute artifact. Loss of positive-health quorum expires consume; loss of emergency-floor quorum makes no invented rapid-off claim and cannot borrow another signer.
- `release freshness` — **invariant**: a nonce-bound, unexpired response from the independent pinned freshness role must name the exact build and a floor/head no lower than the bundle, rollout chain, overlay, and persisted maxima; unavailable/stale/conflicting state disables consume and never borrows the downstream receipt as proof.
- `global observe census` — **invariant**: one signed generation-CAS census admits at most 64 stable private host leases across all pools and rings; reservation, activation, renewal, verified-off release, expiry, and crash recovery are explicit states, and an uncertain or unreachable lease stays charged.
- `fork resolution` — **judgment-candidate**: the closed actions are retain-off, select one exact branch with incident evidence, or revoke/re-key; independent security reviewer and operator signatures are both required, disagreement/unavailability retains off, and the issuer alone has no branch-selection authority.
- `historical framework backlog` — **invariant**: the generated baseline, durable remaining-set digest, weekly bounded scan, owned implementation action, due date, and successful artifact+fixture PR shrink are the state; stale/overdue or non-shrinking state fails relevant PR/release gates and reaches operator attention only through the bounded SelfHealGate.
- `verdict` — **invariant**: exact schema/predicate/expected-state/target/causality mapping produces verified, explicit matching disproof produces contradicted, everything else unknown; one action may verify execution while contradicting its success predicate.
- `coverage` — **invariant**: an exhaustive signed-generation-bound registry+observed local manifest and ≥95% instrumented-turn coverage are required for `observed-mediated-local-action-verification`; unavailable global census/denominator yields `not-verified`, while omitted, unknown, unsupported, ineligible, or unreviewed-shrink local rows yield `partial-observed-mediated-local-verification` independently from clause verdicts.
- `machine-pinned turn` — **invariant**: origin executes, reduces, and closes; ownership movement terminally marks the inbound as possibly executed, forbids automatic replay, and a new host waits for a new instruction. Transparent in-flight transfer is excluded until a separately converged foundation exists.
- `inbound replay admission` — **invariant**: only an authenticated ordered cursor above the carried high-water or an id in a unified pre-launch acknowledged set may enter v2 canonical evidence; an unproved adapter stays on its existing action path with an entirely unverified close, never a partial canonical claim or new action block.
- `runtime mode precedence` — **invariant**: the closed requested-mode/switch/generation/local-admission matrix derives exactly one effective state; every invalid, killed, stale, conflicting, or failed input reduces to dark/off and never legacy.
- `storage` — **invariant**: one bounded local reducer with monotonic CAS, hard cardinality/byte/time limits, immutable two-event per-action staging, at most three staged sources/action, atomic terminal turn reduction into at most two revisions, no action retry, and capacity failure to unknown.
- `projection architecture` — **invariant**: existing recorder + bounded revisions is chosen for one local reducer with no dispatch/retry/callback; a second reducer, historical recomputation, async settlement/retries, provider dispatch, or exported build attestations reopens the decision.
- `cross-machine read` — **invariant**: scrubbed heads only; source/basis preserved; conflict unknown; raw evidence and local authority never move.
- `future scope` — **invariant**: provider durability, pending/post-turn settlement, hidden effects, and blocking have no authority until separately specified and approved.

## Implementation risk register

These are known admission risks, not unresolved design choices:

| Risk | Deterministic acceptance evidence | Failure result |
|---|---|---|
| Claude/Codex candidate and close seams are not yet proven non-spoofable | real launcher-owned action plus forged/omitted/reordered close corpus on each engine/build/OS tuple | row `uncharacterized`; cohort holds |
| Gemini and Grok owned action seams are not yet characterized | live-probed typed action/control event and final-sink suppression with negative fixtures; transcript/session id alone fails | `controlAvailability=unavailable`; cohort holds |
| pi RPC identity is not yet bound to the signed turn | exact RPC action-id/turn binding, abort, late-output, and replay fixtures | row `uncharacterized`; cohort holds |
| Windows and wrapper/plugin enforcement may lack required ownership primitives | the platform contract table's real process/peer/channel-isolation corpus | affected tuple `not-verified`; no proof borrowing |
| bounded custom provenance storage may exceed measured latency/footprint | exact-path 31-day N/N+1 soak, worker-wedge tests, and all custody deny tests | capture/consume stay dark; no positive surface |
| current Slack delivery lacks a unified acknowledged-id set | N/N-1 handoff, redelivery, and before-launch durable-ack fixtures over the real Slack adapter | Slack actions keep pre-v2 behavior and the whole close remains visibly unverified; other adapters are unaffected |
| independent freshness endpoint or release-control publication is not production-ready | nonce replay, stale-valid-bundle after rollback, key rotation, cache, timeout, privacy, and capacity fixtures against the deployed endpoint/package | consume stays off on every host; capture-only dark may continue |
| live LLM route characterization remains dark or diverges | research routes remain unadmitted and runtime verifier remains deterministic | no runtime change; future semantic activation requires a separate approved spec |

## Closed feasibility posture

**No unresolved V1 decision branches.** The feasibility uncertainties in the risk register are not
assumptions that an implementation may fill differently: each has a closed real-system admission
test and least-authoritative outcome. An engine whose owned seam never passes remains
`uncharacterized`, so the global cohort remains dark. The only ways around that outcome are a
separately reviewed canonical-engine removal or a new converged feature/spec; implementations may
not invent transcript fallback, per-engine positive UI, weaker stream ownership, or a local waiver.

## Open questions

*(none)*
