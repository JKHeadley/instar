---
title: "SelfHealGate — bounded self-heal declarations over existing governor and episode primitives"
slug: "self-heal-gate"
author: "echo"
status: draft
approved: true
rollout-disposition: composed
rollout-source-pr: 1538
rollout-owner-feature: feedback-factory-operating-drain
rollout-criteria: "The feedback-factory defaults consumer records at least one verified repair or already-healthy result within its existing bounded governor and episode controls."
rollout-evidence-type: endpoint
rollout-evidence-ref: /feedback-factory/drain/status
rollout-metrics-json: '{"cadenceHours":6,"evidenceMaxAgeHours":12,"metrics":[{"id":"successful-bounded-repairs","source":"feature-summary","sourceRef":"self-heal-gate.successful-repairs","direction":"at-least","threshold":1,"minSamples":1}]}'
parent-principle: "Capacity Safety — No Unbounded Self-Action"
review-convergence: "2026-07-21T12:04:51.495Z"
review-iterations: 6
review-completed-at: "2026-07-21T12:04:51.495Z"
review-report: "docs/specs/reports/self-heal-gate-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# SelfHealGate

## 0. Outcome

Add one small `SelfHealGate` façade that makes a recoverable watcher declare its remediation, episode bounds, notification ceiling, severity, dedupe identity, and audit/notice seams together. It composes the existing `SelfActionGovernor` and `FailureEpisodeLatch`; it does not create another scheduler, breaker, queue, workflow runner, or background loop.

This PR also converts the current warning-only feedback-factory generated-defaults path into the first real application. On a development source checkout, an actually stale/missing generated-defaults file is repaired through the gate. The existing atomic `ensureFeedbackFactoryGeneratedDefaults()` operation is the remediation. Fleet-dark installs remain unchanged.

### Terminology

- **Governor admission/token:** the existing `SelfActionGovernor` signal and consume-once capability checked at the protected side-effect boundary.
- **Episode:** repeated detections of the same dedupe identity until verified recovery.
- **Fence:** a fresh caller-owned eligibility/lease-epoch check proving this process still owns the mutation.
- **Canonical owner:** the existing feedback-drain lease/owner chosen by `resolveFeedbackDrainOwnerMachineId` plus `holdsCanonicalLease`.
- **Attention seam / one voice:** the existing operator-notice enqueue; the gate adds no Telegram/Slack sender.
- **Episode authority:** where episode state is valid—process-local, durable on one physical machine, genuinely shared, or proxied to one fenced owner.

“Façade” is intentional: it gives callers one declarative interface around a deterministic state machine, not a thin pass-through. It owns no clock-driven execution, worker, independent queue, or policy engine. Callers schedule detections; the governor decides admission and owns any queued callback; the latch decides episode signaling; the injected store decides atomicity.

## 1. Grounded foundation audit

The authoritative source reads correct four claims from the preserved draft.

1. **Governor scope is not globally durable or globally enforcing.** `SelfActionGovernor` defaults every class to `observe`; observe mode records a would-deny and still returns allow. Its local snapshot is machine-local. A `resource: 'pool-shared'` declaration affects policy/posture and pool-read aggregation, but does not make an individual admission a cross-machine hard brake. Therefore `SelfHealGate` treats governor admission as the existing capacity-policy signal and token seam, not as proof that episode bounds were enforced pool-wide.
2. **Episode state is in-memory unless a store is explicitly injected.** `FailureEpisodeLatch` has an injected clock and three private fields; it has no persistence API. Governor snapshots cannot persist the latch's episode start, attempt count, notification latch, or give-up latch. A durable consumer must inject a `SelfHealEpisodeStore`; omission means explicitly process-local episode state.
3. **Governor admissions are not heal attempts.** Governor count windows account for admissions under controller policy. `maxAttempts` is the number of remediation invocations in one failure episode. They can differ due to observe mode, coalescing, unrelated targets, restarts, and window rollover. The gate maintains the latter independently in its episode record and never maps it to `perTargetCountCeiling`.
4. **The first application must ship now.** `AgentServer` currently detects `repair-needed` feedback-factory generated defaults and only warns without repairing. This build replaces that warning with the gate-backed, idempotent, atomic repair and verifies the result. A façade with no current consumer would not satisfy the runtime-extraction requirement.

Existing pieces reused:

- `governor.for(controllerId).admit(derivedTarget)` for the existing self-action registration/admission/token contract.
- `FailureEpisodeLatch` for process-local failure duration and one-signal-per-episode semantics.
- `ensureFeedbackFactoryGeneratedDefaults()` for an existing guarded, atomic remediation.
- Existing attention/audit dependency seams; no new operator channel.

## 2. Public contract

`SelfHealGate.declare(spec, deps)` returns an object with `attempt(ctx)` and `recordHealthy(ctx)`.

`SelfHealSpec<Ctx>` declares:

- `id`, matching one registered self-action controller.
- `severity(ctx): 'recoverable' | 'irreversible' | 'data-loss' | 'security' | 'unknown'`.
- `dedupeKey(ctx)` and `classId`, used to derive the governor target and episode key.
- `remediation(ctx)`, returning the closed union `{ outcome: 'healed' | 'pending-restart' | 'not-healed'; evidence: EvidenceCode }`; free-form error bodies are never copied into notices/audit. `pending-restart` is an explicit intermediate state, not success.
- `maxAttempts`, a positive integer bounded to a small implementation maximum.
- `maxWallClockMs`, a finite positive duration.
- `backoffMs(attempt)`, deterministic and non-negative. `attempt()` does not sleep or schedule; a call before `nextEligibleAt` returns `backoff`.
- `notificationLatencyCeilingMs`, finite, positive, and no greater than the constitutional ceiling.
- `flap: { maxRecoveries, windowMs }`; too many recoveries of the same dedupe key makes the next detection notify immediately.
- `remediationActions`, a fixed metadata-only description naming the idempotency guard and rollback/compensation.

`SelfHealGateDeps` declares:

- the existing `SelfActionHandle` (obtained from `governor.for(spec.id)` at the application binding) plus the existing `consumeAdmissionToken` authority;
- `notify(notice)`, a synchronous enqueue into the existing durable attention seam, and `audit(event)`, both metadata-only;
- injected `now()`;
- `controllerResource` and v1 `episodeAuthority: 'process-local' | 'durable-machine-local'`. Both reject `pool-shared`; a pool-shared consumer cannot compile/declare against v1 and must first ship a separately converged shared-store or single-owner-proxy contract.
- optional explicit `episodeStore`. The default `InMemorySelfHealEpisodeStore` is honestly process-local. `SqliteSelfHealEpisodeStore` is injected by the feedback-defaults application and persists beneath the configured state directory using revisioned transactional claims, bounded rows, schema validation, and restrictive permissions.

The store is capped at 256 episode rows. It may prune only terminal recovered rows whose flap window has expired, oldest first. It never evicts an active, notified, exhausted, or still-flap-relevant row; if safe pruning cannot make room, the new attempt returns `state-failure` and notifies instead of resetting a budget. SQLite `BEGIN IMMEDIATE` plus a revision predicate performs the claim; `busy_timeout` is short and bounded, and busy/constraint failure returns `busy` without mutation. This reuses the repository's existing SQLite/WAL dependency instead of inventing a JSON lock/database. The implementation validates the anchored private parent and refuses a symlink/non-regular pre-existing database.

Invalid declarations throw at startup. This is configuration/programmer error, not a runtime degradation.

## 3. One attempt, in order

For one `attempt(ctx)`, the gate performs exactly this deterministic sequence:

1. Canonicalize the dedupe key, load/create the episode by `(spec.id, dedupeKey)`, and validate the stored record. If durable state is unreadable/invalid, refuse remediation and use a separately bounded process-local fallback notice latch; no fresh durable record is substituted and durable cross-restart dedupe is not claimed for this failure path.
2. Resolve severity, then transactionally move a reason-specific notice from absent to `pending` with a stable idempotency id. `unknown-severity`, each critical class, `latency`, `max-attempts`, `wall-clock`, `flap`, and `state-failure` have distinct closed keys, so an early conservative notice never suppresses a later, more specific one. Synchronously enqueue using that stable ID, then CAS `pending -> enqueued`. A crash/restart seeing `pending` retries the same ID; the existing attention seam dedupes it. `pending` is never treated as delivered. This is explicitly a minimal transactional-outbox marker across the episode/attention transaction boundary, scoped only to enqueue state—not another sender or general queue. Pending rows remain active/non-prunable and retry on invocation; enqueued markers prune only with their safely prunable terminal episode. **Missing, thrown, or `unknown` severity synchronously enqueues one HIGH notice and does not remediate.** This is the conservative default; uncertainty cannot silently enter the heal-first lane.
3. For `irreversible`, `data-loss`, or `security`, synchronously enqueue the URGENT notice before remediation, record the enqueue result, then continue regardless of downstream delivery completion. The injected seam must enqueue without network I/O; a rejecting/hanging network sender is downstream of that durable queue and cannot block heal.
4. Record detection through the composed `FailureEpisodeLatch`. Its net-new versioned snapshot is `{ schemaVersion: 1, failingSince: number|null, failures: number, signaledFor: number|null }`. Restore rejects non-finite/future-negative/internally inconsistent values; `signaledFor` must be null or equal `failingSince`. Restore sets exactly those fields and the injected clock remains authoritative. It does not replay calls or duplicate transition logic.
5. If the notification ceiling has been reached, claim/enqueue the `latency` notice and continue this call if the terminal bounds still permit remediation. If wall-clock give-up, flap limit, or episode `maxAttempts` has been reached, claim/enqueue that reason, persist the terminal latch, and return `exhausted` without remediation. Latency notification is non-terminal; the other three stop further remediation.
6. If `nextEligibleAt` is in the future, return `backoff` without governor admission or remediation.
7. Ask the existing governor handle for admission, passing the caller's eligibility/fence callback and a bounded `onAdmitted(token)` continuation owned/invoked synchronously by the existing governor drain. In `enforce`, a queue outcome returns from this invocation; if the same process later drains it, the callback re-enters only the post-admission path with the supplied token, reloads the latest episode revision, rechecks terminal bounds and fence, consumes that exact token, claims at most one attempt, and contains/audits all errors. Coalesced queue entries retain one callback, so a drained admission causes at most one side effect. The callback has no restart guarantee: after restart, the durable episode remains unspent and boot detection calls `attempt()` again. In `observe`, a would-deny remains an allow by governor design. The gate records the exact admission reason. This uses the governor's existing queue; the gate creates none.
8. Revalidate eligibility/owner epoch, then consume the governor token with pinned `spec.id` and exact derived target key using the existing `consumeAdmissionToken` authority. The gate honors `proceed`, not `valid`: in enforce mode an invalid/expired/replayed/wrong token returns `governed`; in observe mode the existing authority deliberately returns `proceed: true`, so remediation continues with `tokenValid: false` audit metadata. A stale application fence always refuses because it is the consumer's side-effect eligibility, not a governor policy signal.
9. Atomically claim one remediation invocation with `episodeStore.claimAttempt(key, expectedRevision, fence)`. The claim itself revalidates the fresh fence immediately before commit. The in-memory store serializes per key; the SQLite store opens `BEGIN IMMEDIATE`, reloads and compares revision, increments the attempt, and commits. A concurrent loser returns `busy` without side effect. This is narrow synchronization, not a scheduler/queue/engine. A successful claim is followed immediately by exactly one remediation invocation, so `maxAttempts` retains its stated meaning; a crash may spend an invocation without completing it, never spend one on a pre-claim governor/fence refusal.
10. Invoke `remediation(ctx)` once. V1 deliberately requires a synchronous remediation result; declarations returning a Promise are rejected by the type/runtime assertion. Therefore the gate's episode wall-clock bound is checked between invocations and no v1 API implies that it can abort arbitrary async work.
11. A verified `healed` result closes the failure episode, records recovery/flap history, and persists before returning `healed`. `pending-restart` transactionally persists the stable restart marker, requests the existing authority once, returns `attempted` without failure backoff, and does not close. `not-healed` or throw records failure evidence and `nextEligibleAt`; error text is scrubbed to a fixed reason enum. Fixed diagnostic fields may include operation enum and OS error code from an allowlist, never message/path/content. Every mutation—detection, notice pending/enqueued, attempt claim, failure/backoff, healed close/flap history, `recordHealthy`, terminal exhaustion, restart marker, and prune—is revision-CAS in one store transaction. Conflicts reload and either retry once when semantically safe or return `busy`; terminal/exhausted state is monotonic and no stale writer may reopen/reset it.

The result union is `healed | attempted | backoff | busy | governed | exhausted | invalid-severity | state-failure`. Notice outcome is orthogonal fixed metadata (`noticeAttempted`, `noticeReason`) so a critical notice cannot hide the remediation outcome.

## 4. State and multi-machine posture

The gate has no replication protocol. Episode authority follows the application owner.

For the first application, feedback-drain ownership is already single-owner/lease-gated and the generated-defaults file is a source-checkout-local operational artifact. Its injected SQLite episode store is therefore **machine-local by physical artifact**, while operator notification still uses the existing one-voice/attention path. The remediation is eligible only on the canonical feedback-drain owner; a non-owner does not run it. A topic or lease move does not claim to move this host-local file or its episode history.

If ownership moves to another physical machine, that machine evaluates and, if needed, repairs its own checkout under a distinct local episode. The old host's episode does not migrate. At most one bounded notice per host/reason is acceptable because these are distinct hardware-local artifacts, not duplicate reports of one shared mutation.

machine-local-justification: hardware-bound-resource — the repaired generated-defaults file configures the local development source checkout and is not meaningful on a peer host with a different checkout/state directory.

Future applications whose remediation target is pool-wide must inject a genuinely shared/replicated episode store or proxy all gate attempts to a single fenced owner. Merely declaring the governor controller `pool-shared` is insufficient and is explicitly rejected.

| Episode authority | Allowed controller resource | Required fence | Persistence scope |
|---|---|---|---|
| `process-local` | `hardware-bound` only | same-process eligibility callback | memory only |
| `durable-machine-local` | `hardware-bound` only | local owner/incarnation callback where ownership can move | injected local store |
| future `shared-store` | `pool-shared` | shared-store CAS plus machine/lease epoch | not accepted by v1 API |
| future `single-owner-proxy` | `pool-shared` | authenticated request routed to one lease/epoch-fenced owner | not accepted by v1 API |

V1 ships only `process-local` and `durable-machine-local`. The pool-wide rows define the admission constraint, not an implementation claim; adopting either requires its own converged store/proxy design.

## 5. First application: feedback generated defaults

The application binds only when all existing conditions hold: development agent, source checkout, the feedback drain store/service and its owner/lease functions have initialized, this process is the canonical owner, and either typed generated-default inspection reports absent/stale **or** the durable episode carries `restart-required`. The drain does not depend on this generated file to initialize in the current process; initialization provides the ownership fence first, then this repair corrects generated posture for the next boot. This is the deliberate post-owner lifecycle—no circular claim that the file enabled the already-running drain.

- Controller id: `feedback-factory-generated-defaults-heal` (new registry entry and governor policy).
- Governor policy: explicit hardware-bound `relief` class with the canonical `open-audited` failure direction. Ordinary enforce denials use the governor's existing queue and the bounded continuation above; admit-path errors retain the canonical relief open-with-audit posture. Count/rate ceilings remain independent capacity telemetry—not the episode's three-attempt authority.
- Dedupe key: fixed literal `generated-defaults` inside this agent's already-separated local episode database. No path/canonicalization/migration semantics enter identity, audit, or notice text.
- Severity: a new typed inspection distinguishes absent/valid-but-stale (`recoverable`) from malformed JSON, access/I/O error, symlink, or non-regular file (`unknown`, immediate notice, no repair). The current catch-all `repair-needed` result is not sufficient and is replaced without silently broadening repair authority.
- Remediation: call the hardened existing `ensureFeedbackFactoryGeneratedDefaults()`, then re-run typed inspection. It canonicalizes and anchors the trusted state root; rejects symlink/non-directory parents and symlink/non-regular destinations; creates a randomized `O_CREAT|O_EXCL|O_NOFOLLOW` mode-0600 temp in a verified private directory; writes, fsyncs, closes, atomically renames, fsyncs the parent, and cleans up on every failure. The previous destination remains intact until rename. A fresh owner/lease/epoch fence is checked immediately before the mutation claim. A changed+healthy write returns `pending-restart`, never `healed`.
- Bounds: `maxAttempts: 3`, `maxWallClockMs: 10m`, deterministic backoff `0s, 30s, 120s`, notification ceiling `2m`, flap threshold `3 recoveries/24h`.
- Durable episode store: explicit SQLite store below the same local state root, not the governor snapshot.
- Current boot invocation: one immediate attempt after the drain and its canonical-owner/lease functions exist. If verification says bytes changed, remediation returns `pending-restart`. The gate persists `{ restartState: 'required', requestingBootId, stableRequestId }`; `required` never suppresses retry. It writes the existing restart request idempotently with `stableRequestId`, then CASes `required -> requested`. A crash before/after the write retries the same ID without clobbering or duplicating authority. Verification may CAS `requested -> verified` and close only when typed inspection is healthy **and** the current injected boot-incarnation differs from `requestingBootId`; a same-boot call returns `attempted` without another remediation claim or close. The `required|requested` marker makes the application invoke the gate even when inspection is healthy. Unhealthy on the next boot remains in the same monotonic attempt/wall-clock episode and notices. This façade introduces no timer; later boots/governor drains are the only continuations.

The restart substate is explicitly `none -> required -> requested -> verified`. It is a small application-specific two-boot workflow in the feedback-defaults binding, driven only by existing boot and restart authority; it is not part of the generic gate API and is not a new general workflow engine.

Successful repair is observable in the current boot as typed inspection `healthy` plus one restart request; completion is verified on the next boot as required by the feedback-drain contract. The already-initialized current drain remains live until the planned restart. If the gate cannot heal or request/verify restart, boot remains non-fatal and the operator receives the bounded notice through the existing attention seam.

## 6. Security and failure behavior

- Dedupe keys, paths, exception messages, and remediation evidence are never emitted verbatim. Events use fixed enums plus controller id, attempt ordinal, relative durations, and hashed target identity.
- Store reads validate schema/version, finite integers, enum values, record count, and maximum file size. Symlinks and paths outside the injected root are refused. The private directory's ownership/mode are validated; writes use randomized exclusive no-follow mode-`0600` temps, file+directory fsync, atomic rename, and cleanup.
- Notice/audit sink failure is recorded through the other sink when possible and never turns a critical degradation into “healthy.”
- Remediation throws are contained and converted to `attempted`; they do not crash server boot. Diagnostic enums include `source-absent`, `schema-stale`, `malformed-json`, `access-denied`, `io-error`, `symlink-refused`, `non-regular-refused`, `sqlite-busy`, `fence-stale`, and `verification-failed`, plus an allowlisted OS code where applicable.
- No async remediation is accepted in v1. The current writer is short synchronous boot work over a fixed payload below 1 KiB and one local SQLite transaction, and the gate runs only on detected repair before request serving—not a hot path. Boot is explicitly allowed to block; healthy boots do no mutation. Audit records gate/remediation elapsed milliseconds so unexpectedly slow boot I/O is visible. No hard OS-I/O latency guarantee is claimed—an indefinitely wedged filesystem can still wedge boot, as existing synchronous boot storage already can. Before any slower/network remediation is adopted, the named v2 `AbortSignal` contract must converge; `Promise.race` alone is forbidden because it would leave mutation running after the gate reports exhaustion.
- No secrets, raw config, or file contents enter the episode store.

## 7. Explicit non-goals

- No parallel breaker, retry loop, timer, scheduler, queue, workflow engine, or cross-machine coordinator.
- No claim that observe-mode governor admission blocks work.
- No claim that governor snapshots persist gate episodes.
- No equation between governor count ceilings and per-episode remediation attempts.
- No generic automatic repair registration by string or config; applications bind in code and are registry/lint reviewed.

## 7.1 Architectural alternatives

- **One-off boot repair:** smaller, but it would repeat severity, notice, episode, and governor glue at the next watcher and would not satisfy the mandated reusable first extraction. Generated defaults are a good proving ground precisely because the current degradation is real, the operation already exists, is local/idempotent, and has a warning-only gap without external business side effects.
- **Standalone workflow/retry engine:** rejected because governor admission/token authority and latch episode semantics already exist. A second breaker/queue would race and double-account.
- **Let governor ceilings equal heal attempts:** rejected because observe mode allows, windows roll over, and admissions are not per-episode side-effect executions.
- **Always use durable SQLite:** rejected. Process-local consumers may select in-memory honestly; durable local consumers may inject SQLite; pool-wide consumers require a shared store or fenced single owner.

## 8. Technical acceptance tests

### Unit

- Declaration validation, exact result union, severity missing/unknown/throw immediate notice and zero remediation.
- Critical severity notices before remediation settles.
- Recoverable path unreachable-to-notice before exhaustion except latency backstop.
- Attempt count persists before side effect and never exceeds `maxAttempts`, including re-instantiation.
- Wall clock, backoff, flap, dedupe, one-notice-per-episode, recovery/re-arm.
- Governor observe would-deny still allows; enforce queue/coalesce does not remediate.
- A real enforce denial queues once; drain-time `onAdmitted` re-entry produces exactly one side effect with fresh revision/token/fence, while ineligible/terminal continuations produce zero and no orphan admission.
- Governor tokens: valid consume, expiry, replay, wrong controller, and wrong target in both modes; invalid observe tokens remain signal-only/proceed while invalid enforce tokens stop. Eligibility loss between detection/admission/consume/mutation always stops.
- Concurrent same-process calls and two SQLite-store instances cannot exceed the attempt bound; transaction/revision loser returns `busy`.
- Races: `recordHealthy` vs claimed attempt, heal-close vs failure write, pending/enqueued notice vs recovery, restart marker vs close, and prune vs active mutation preserve monotonic terminal/attempt/flap state.
- Boot one `pending-restart` cannot close; boot two enters through the marker even with healthy inspection and alone records `restart-verified`/close.
- Restart handshake: duplicate same-boot invocation, request-write failure, crash before/after request write, stable-id retry, and different-boot verified close.
- Notice crash boundaries (before pending, pending-before-enqueue, enqueue-before-CAS) retry one stable id without loss or duplicate attention.
- Durable store schema, corruption, size/path/symlink defenses, atomic write, bounded eviction.
- `FailureEpisodeLatch` snapshot/restore parity.
- Typed generated-default inspection and hardened writer: malformed/unreadable/symlink destination or parent never reaches mutation; randomized-temp collision, permissions, rename/crash cleanup, fsync seams.

### Integration

A shared conformance fixture drives the real gate with the real governor core in both observe and enforce modes. It asserts unreachable-before-exhaustion, observable remediation evidence, flapping auto-escalation, latency notification while healing remains eligible, crash/restart attempt conservation, and no duplicate notice.

### E2E

Start the production `AgentServer` path with a development source-checkout fixture whose generated defaults need repair. Assert boot one invokes the real gate, the file becomes healthy, and exactly one existing-authority restart request is written; boot two verifies healthy, closes the episode, does not request another restart, and the feedback-drain status surface is live. A corrupt-state fixture asserts immediate notice, no overwrite, and no restart.

## 9. Repository delivery ceremony

Build, lint, targeted tests, full push suite, security review, side-effects report, ELI16 companion, release fragment, independent second pass, PR CI, and repository safe-merge are required. These are delivery gates, separate from the behavioral acceptance tests above.

## Frontloaded Decisions

- **FD-A — façade, not engine:** compose governor + latch and add only declaration, episode accounting/persistence seam, and deterministic orchestration.
- **FD-B — explicit persistence:** process-local is the default type; durability exists only through an injected store. The first application injects the SQLite implementation.
- **FD-C — episode attempts are separate:** `maxAttempts` is persisted per episode and is never inferred from governor admissions.
- **FD-D — conservative severity:** missing/throw/unknown immediately notifies and does not remediate.
- **FD-E — real first application in this PR:** feedback generated-default repair ships in this change.
- **FD-F — no scheduler:** callers invoke the gate; v1 never creates a retry timer.
- **FD-G — local first consumer:** the local checkout artifact uses the closed-taxonomy `hardware-bound-resource` justification; pool-wide consumers require shared state/one owner.
- **FD-H — governor queue continuation:** canonical relief/open-audited policy is retained; enforce queue drain resumes through the gate's bounded post-admission continuation rather than discarding admission or creating a second queue.
- **FD-I — post-owner restart lifecycle:** repair runs after fenced owner initialization, requests one restart through existing authority only when bytes changed, and verifies on the next boot.

## Decision points touched

- **Severity routing — `invariant`.** Closed enum; critical classes notify before heal, recoverable enters bounded heal-first, missing/unknown/throw immediately notifies and stops. This is a safety classification with a conservative fixed default, not a competing-signals judgment.
- **Episode exhaustion — `invariant`.** Fixed arithmetic over persisted attempts/timestamps/flap history; exceeding a declared bound stops remediation.
- **Governor admission — `invariant`, owned by existing `SelfActionGovernor`.** The façade consumes its exact result and preserves observe/enforce semantics; it adds no classifier.
- **First-application eligibility — `invariant`.** Existing development/source-checkout/owner/posture predicates plus deterministic file inspection.
- **Stored-state validity — `invariant`.** Closed schema and bounded numeric/path checks; invalid durable state notifies and refuses mutation.

## Open questions

*(none)*
