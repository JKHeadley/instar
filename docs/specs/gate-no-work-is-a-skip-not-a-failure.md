---
title: "A gate answering 'no work to do' is a SKIP, not a retryable failure"
slug: "gate-no-work-is-a-skip-not-a-failure"
author: "echo"
eli16-overview: "docs/specs/gate-no-work-is-a-skip-not-a-failure.eli16.md"
---

# A gate answering "no work to do" is a SKIP, not a retryable failure

> **Revision note.** An earlier draft of this spec inferred gate meaning from the process
> exit code and explicitly rejected a per-job declaration as unnecessary. **A cross-model
> review challenged that, an audit of the real gate corpus refuted it, and the design below
> is the corrected one.** The refuting evidence is kept in place rather than deleted,
> because it is the reason the design is shaped this way.

## Problem statement

A scheduled job may declare a `gate` — a shell command acting as a cheap, zero-token
pre-screen. Exit 0 means run; non-zero means don't.

`JobScheduler.runTick` treats **every** non-zero gate as a **failure** and puts the job on
the retry backoff ladder:

```ts
if (job.gate) {
  if (!await this.runGateAsync(job)) {
    this.scheduleRetry(slug, 'gate');   // ← advances the ladder
    return 'skipped';
  }
}
```

`RETRY_DELAYS_MS` is `[1m, 5m, 15m, 30m, 1h, 2h]`. A job whose gate correctly and routinely
answers "nothing to do" therefore walks the whole ladder on every cron tick, re-running the
gate at each rung, then logs `exhausted 6 retries`. Since `runGateAsync` also retries
internally (`gateRetries`, default 3), one cron tick can execute the gate **up to 18 times**
to re-learn its first answer.

**Observed, not theorised.** `insight-harvest` was seen walking `retry 1/6` through `6/6`,
every line reading `(gate)`, exhausting the ladder three separate times.

Harms, in increasing seriousness:

1. **Wasted work** — up to 18 executions per tick for one answer.
2. **Destroyed cadence** — the job leaves its cron and rides a backoff ladder. An hourly job
   idle at 02:00 is next asked at 02:01, 02:06, 02:21, 02:51, 03:51, 05:51. **A healthy idle
   job becomes a starved job when work appears.**
3. **A false failure signal** — `exhausted 6 retries` is what a genuinely broken job emits.
   Healthy jobs emit it constantly, so it stops carrying information.

## The audit that determines the design

The obvious fix is "don't retry when the gate says no". The obvious refinement is "infer
from the exit code whether the gate *answered* or *failed to run*". **Both are wrong, and
the gate corpus is what proves it.**

Every gate defined on a live agent, classified:

| gate shape | count | what a non-zero exit MEANS |
|---|---:|---|
| `curl -sf …/health` only | **13** | the server is down — a **transient precondition** |
| `curl -sf …/health && test -f …` | **2** | server down **or** file missing — mixed |
| `test -f …` only | **1** | a precondition is absent |
| a real work-presence check (e.g. `curl …/evolution/learnings…`) | **4** | **there is no work** |

**Only 4 of 20 gates actually mean "no work".** Fifteen are health probes, where a non-zero
exit means *try again shortly* — precisely what the retry ladder is for.

And the exit codes are measured, not assumed:

```
curl -sf → server down (connection refused)  → exit 7
curl -sf → HTTP 404                          → exit 22
curl -sf → server up, 200                    → exit 0
test -f  → file missing                      → exit 1
```

7 and 22 are ordinary numeric exit codes. **Under exit-code inference, a server restart
would classify as "the gate answered no work" for 15 of 20 jobs, and every one of them
would skip to its next cron instead of retrying in 60 seconds.** That is strictly worse
than today's behaviour, during exactly the window when jobs most need to recover.

The same command shape (`curl -sf`) means "no work" in one job and "the server is
restarting" in another. **No property of the process can distinguish them, because the
difference lives in the job author's intent.** Therefore the job must declare it.

## Proposed design

**1. A job declares what a non-zero gate MEANS. Default = today's behaviour.**

```ts
// JobDefinition
gateMeans?: 'no-work' | 'precondition';   // absent ⇒ 'precondition'
```

- `'precondition'` (**default, and what every existing job gets**) — a non-zero gate is a
  transient blocker. Retry ladder as today. **Byte-identical to current behaviour.**
- `'no-work'` — a non-zero gate is a legitimate answer. **Skip; do not advance the ladder.**

Only the 4 genuine work-presence gates set `'no-work'`. Nothing else changes. This is
backward-compatible by construction: the risky behaviour is opt-in, and the 15 health
probes keep the retry they depend on.

**1a. The declaration is REQUIRED at authoring time, tolerated at runtime.** *(Structure
beats Willpower — added after the conformance gate observed that an optional field means a
future author gets the wrong behaviour by forgetting.)*

An optional field is a wish. So the two halves are split:

- **Authoring (strict, structural).** A repo lint fails any job **manifest** that declares a
  `gate` without a `gateMeans`. A future work-presence gate cannot be authored in a manifest
  without its author stating which case it is.
  **Code-constructed jobs are covered by the TYPE, not by the lint.** `JobDefinition`
  becomes a discriminated union so the compiler itself refuses a gated job with no
  declaration:

  ```ts
  type JobDefinition = BaseJob & (
    | { gate?: undefined; gateMeans?: never }
    | { gate: string;     gateMeans: 'no-work' | 'precondition' }
  );
  ```

  A job constructed in code without `gateMeans` no longer compiles. Between the lint
  (manifests) and the type (code), every job authored **inside this repo** must declare.

  **The one remaining boundary, stated honestly:** a third-party plugin supplying a job as
  runtime JSON is checked by neither — no static analysis can see it. It falls back to the
  runtime default (`'precondition'`, today's behaviour), so it fails safe rather than
  silently wrong. That residue is real and is named rather than claimed away.
- **Runtime (tolerant, safe).** An absent `gateMeans` resolves to `'precondition'` —
  today's behaviour. A deployed agent carrying an older manifest keeps working exactly as
  it does now.

The split is deliberate: making the field *required at runtime* would break every deployed
agent whose manifests predate it, converting a correctness fix into an outage. Strictness
belongs where the mistake is made (authoring), tolerance where the blast radius is
(production).

**1b. Migration (Migration Parity Standard).** Existing agents update in place, so the
shipped job manifests carrying gates are stamped with their correct declaration as part of
this change — `'precondition'` for the 15 health probes and 1 file check (behaviour-
preserving, mechanical), `'no-work'` for the 4 audited work-presence gates. `migrateJobs`
is idempotent and only writes a `gateMeans` that is absent, so a manifest an operator has
already tuned is never overwritten.

**2. `runGateAsync` returns a discriminated outcome — for BOTH declarations.**

```ts
type GateOutcome =
  | { kind: 'passed' }
  | { kind: 'answered'; exitCode: number }
  | { kind: 'could-not-run'; reason: 'timeout' | 'spawn-error'; detail: string };
```

Classification from the rejection shape:

- `signal != null || killed === true` → `could-not-run` / `timeout`
- `typeof code === 'string'` (`ENOENT`, `EACCES`) → `could-not-run` / `spawn-error`
- `code === 126 || code === 127` (POSIX: shell could not execute) → `could-not-run`
- any other numeric `code` → `answered`
- anything unrecognised → `could-not-run` (**fail toward retry**)

This distinction is *still* worth making, because a gate that could not run is never a
legitimate answer under **either** declaration — a mistyped command should retry, not be
mistaken for "no work". But it is no longer asked to carry the meaning; `gateMeans` does.

**2a. The internal `gateRetries` loop is narrowed ONLY for `no-work` jobs.** An earlier
draft narrowed it for everything and simultaneously claimed the default was byte-identical.
Those cannot both be true, and the review caught it: a health probe answering exit 7 would
have lost its 3 internal attempts, changing recovery latency for the 15 jobs the default is
supposed to protect. So:

- `gateMeans: 'precondition'` (the default) → internal retries **unchanged**, all 3 attempts,
  on any non-zero. Genuinely byte-identical.
- `gateMeans: 'no-work'` → an `answered` outcome is authoritative on the first attempt;
  only `could-not-run` is re-attempted.

The efficiency gain is thus scoped to the jobs that opted in, which is the only place it was
ever safe to take.

**3. The call site routes on declaration first, outcome second.**

```ts
if (job.gate) {
  const outcome = await this.runGateAsync(job);
  if (outcome.kind === 'could-not-run') {
    this.scheduleRetry(slug, `gate-${outcome.reason}`);   // always retryable
    return 'skipped';
  }
  if (outcome.kind === 'answered') {
    if (job.gateMeans === 'no-work') {
      this.clearGateRetryState(slug);                     // see §4
      this.skipLedger.recordSkip(slug, 'gate-no-work');
      return 'skipped';                                    // ← ladder untouched
    }
    this.scheduleRetry(slug, 'gate-precondition');        // today's behaviour
    return 'skipped';
  }
}
```

**4. Retry state is cleared narrowly, not wholesale.**

An earlier draft called `clearRetryState(slug)`, which would retire backoff accumulated by a
genuine *execution* failure simply because a later tick found no work.

Retry state is therefore keyed `(slug, origin)` where origin is `'gate' | 'execution'`,
rather than by slug alone. Explicitly:

- **Both origins may be active at once** (a job that failed execution, then later ticks with
  no work). They are independent ladders with independent rung counts.
- **Precedence when both are armed: the EARLIEST next-attempt time wins.** The job is
  retried at whichever ladder comes due first; the other's timer is left intact.
- **A `no-work` answer clears only the `gate` origin.** Execution backoff survives untouched.
- **A successful run clears both**, as today.

Stating this is necessary because "tagged by origin" sounds trivial and is not — the current
model is keyed by slug alone, so this is a change to the retry-state shape, not a filter over
it.

**4a. An unverifiable declaration is trusted — but not forever.**

`gateMeans: 'no-work'` is a human assertion. The machine cannot verify it, and a wrong one
means the job skips silently and indefinitely. Rather than pretend the declaration is proof,
its authority is **bounded by corroboration**:

> A `no-work` job that has **never once been observed passing** within
> `uncorroboratedAfterDays` (default **30**) of its first recorded tick reverts to
> `'precondition'` behaviour and records `gate-declaration-uncorroborated`.

**The threshold is elapsed TIME, not a tick count — and that correction matters.** A
count-based rule (an earlier revision used 20 consecutive answers) recreates the exact bug
this spec removes: an hourly job whose work genuinely arrives monthly trips 20 answers in
under a day and gets pushed back into ladder churn, which is the failure mode the whole
change exists to eliminate. Elapsed time is cadence-independent — a monthly job passes
comfortably inside 30 days; a misdeclared gate never passes at all.

**Precisely what one observed pass does and does not establish.** It disproves exactly one
proposition: *"this gate can never return zero."* That is the failure it is aimed at — a
permanently broken command (a typo, a removed endpoint, a syntax error) which would otherwise
skip its job silently forever. It establishes **nothing** about whether the `'no-work'`
declaration is semantically correct: a gate that is really a health probe will also pass the
moment the server is up, and that pass corroborates nothing about work presence.

**No evidence available to the scheduler can close that second gap**, and this spec does not
pretend otherwise. Whether a gate's non-zero exit truly means "no work" is a claim about
author intent, checkable only by review — which is why §1a forces the claim to be stated
explicitly where a reviewer will see it, rather than inferred at runtime where nobody will.
This is a stated, accepted residual limit, not an oversight: the alternative to accepting it
is to keep adding machinery that narrows the claim without ever grounding it.

This does not decide the declaration is *wrong*. It stops the scheduler acting on an
**unproven** assertion indefinitely, and the fallback is the safe default rather than a new
behaviour. A single observed pass corroborates the declaration **permanently** for that job,
so a real work-check pays this cost at most once, before its first pass — and a job whose
work arrives less often than every 30 days sets `uncorroboratedAfterDays` explicitly, which
is a declaration its author is uniquely able to make.

**5. Skip reasons become distinguishable.** `gate` splits into `gate-no-work`,
`gate-precondition`, `gate-timeout`, `gate-spawn-error` in the skip ledger and the
`job_gate_skip` event. Today all four read `gate` — which is exactly why this went unseen.

**6. `never-observed-passing` telemetry.**

Per job: `consecutiveAnswered` (integer) and `lastGatePassAt` (ISO timestamp or `null`), stamped into the already-emitted
`job_gate_skip` metadata and surfaced on the **existing** `GET /jobs` and `GET /jobs/:slug`
responses beside `skipSummary`/`workloadTrend`.

**Named honestly: this is telemetry, not detection.** `lastGatePassAt === null` proves only
that **no pass has been observed**. It does not prove a gate is malformed — a job whose work
arrives monthly is indistinguishable. It is recorded and **never acted upon**; nothing in the
scheduler branches on it. Its value with insufficient history is `null`, never `false`.
Its close path is the existing job-health surface a human already opens, so it is not left
depending on someone remembering it exists.

## Rejected alternatives

**A reserved-exit-code contract** (`0 = run`, `10 = no work`, other non-zero = precondition).
This is the industry-common shape and it has a real advantage the chosen design lacks: the
meaning travels with the command, so manifest metadata cannot drift away from what the
command actually does. **Rejected because** it requires editing every existing gate command
to adopt the convention, and — worse — a gate that has *not* been migrated is silently
mis-read rather than loudly rejected: today's `curl -sf` exiting 7 would be "precondition"
by luck rather than by declaration, and a work-check exiting 1 would be mis-classified with
no signal. The declaration approach fails safe for un-migrated jobs (they get the default,
which is today's behaviour) and the lint makes non-declaration impossible going forward.
**The drift risk is real and is accepted**: a manifest can claim `'no-work'` for a command
that is actually a health probe. Nothing detects that; only review does.

**Separate `readyGate` / `workGate` fields.** Cleaner semantics — one field per question,
no meaning overloaded onto one command. **Rejected because** it doubles the gate surface for
a corpus where 15 of 20 jobs need only one of the two, and every existing `gate` would need
classifying into one field or the other — the same migration cost as the exit-code contract,
without its advantage of keeping meaning inside the command.

## Decision points touched

| # | decision point | classification | justification |
|---|---|---|---|
| 1 | *Did the gate pass?* (`exit 0`) | **invariant** | Unchanged; the documented contract gate authors already write against. One shell status, no competing signals. |
| 2 | *Did the gate ANSWER, or fail to run?* | **invariant** | Mechanical: exited-with-status vs killed-by-signal vs never-spawned are mutually exclusive facts reported by the OS. Unrecognised shapes route to `could-not-run`, preserving today's retry. |
| 3 | *Does a non-zero answer mean "no work"?* | **not an inference at all** — a **declaration** | This is the decision the audit removed from the scheduler entirely. It is not classified `invariant` because the scheduler no longer decides it; the job author does, and the default preserves current behaviour. Making it a judgment call would be the defect: the evidence available at runtime genuinely cannot distinguish the cases. |
| 4 | *Should the ladder advance?* | **invariant** | A pure function of #2 and #3. |

No point weighs competing or noisy signals. The one place where ambiguity genuinely exists
(#3) is resolved by declaration rather than by a rule adjudicating evidence that cannot
settle it — which is the correct response to that situation, not an evasion of it.

## Verify the State, Not Its Symbol

- **Symbol:** the shape of the `execFile` rejection (`signal` / `killed` / `code`).
- **State claimed:** "the process completed and returned a status" — **NOT** "a valid gate
  answered". Those are different claims and an earlier draft conflated them. A shell syntax
  error, a bad flag, a missing subcommand inside `sh -c`, an auth misconfiguration, or a
  changed response schema all produce ordinary numeric exits. The exit code establishes
  process completion and nothing about answer validity.
- **What carries answer validity instead:** the declaration — and its authority is
  **bounded**, not absolute. A `no-work` declaration is a human assertion; the lint (§1a)
  forces it to be made explicitly but cannot verify it is true. So the scheduler does not
  act on it indefinitely: §4a reverts a declaration that has never been corroborated by a
  single observed pass back to the safe default. **No unverifiable assertion is granted
  permanent authority over a decision** — that is the standard's actual requirement here,
  and an earlier draft satisfied it only by admitting the gap in prose.
- **Corroboration:** produced by the kernel and Node runtime, not by the gate command —
  a gate cannot fake `killed` or suppress `ENOENT`. Strictly stronger than parsing the
  gate's own stdout/stderr, which it fully controls.
- **Unmeasurable case:** an unrecognised rejection shape is explicit `could-not-run`, routed
  to today's retry. Never a fabricated "answered".
- **Bidirectional contest.** *Symbol present, state absent:* a numeric code from a shell
  syntax error. 126/127 removes the common case; the rest is caught by the fact that such a
  job must have *declared* `gateMeans: 'no-work'` to skip at all — an unreviewed job cannot
  fall into the risky path by accident. *State present, symbol absent:* a gate killed at the
  timeout boundary while exiting → `could-not-run` → retry, i.e. today's behaviour.
- **The claim this spec does NOT make:** that it can tell a malformed gate from a
  never-yet-triggered one. It cannot; §6 records that as an explicit unknown.

## Multi-machine posture

**Posture: `unified`.** No `machine-local-justification` is claimed or required.

**This spec DOES add an observable surface** — corrected from an earlier draft that claimed
otherwise while §6 added response fields. `GET /jobs` and `GET /jobs/:slug` gain
`consecutiveAnswered` (integer) and `lastGatePassAt` (ISO-8601 string, or `null` when never observed passing, or absent when history is insufficient); `job_gate_skip` gains the
same in metadata; `JobDefinition` gains optional `gateMeans`. All are **additive**: existing
consumers reading existing fields are unaffected, and absent `gateMeans` means current
behaviour.

**The new state's durability and machine-scope, treated rather than dismissed.** An earlier
draft waved this through as "no new state"; §4a introduced corroboration state and that is
no longer true.

- **`lastGatePassAt` MUST be durable, not in-memory.** It is derived from the persisted
  skip-ledger / activity-event record, which already survives restarts. This is load-bearing:
  if it lived in scheduler memory, every server restart would reset the §4a window and a
  misdeclared gate would **never** reach its 30-day revert — the corroboration check would
  be permanently unreachable, which is precisely the class of defect where a guard exists
  but can never fire.
- **The retry ladder stays in-memory, and that is unchanged and correct.** A restart clears
  backoff and the job resumes on its cron — the pre-existing behaviour, not introduced here,
  and the safe direction (a restart un-parks a job rather than stranding it).
- **Corroboration is UNIFIED across machines, not per-machine.** An earlier draft made it
  machine-local and justified that as "replication would buy nothing". That was wrong on the
  merits, not merely undefended: **"can this gate ever pass?" is a property of the GATE, not
  of the observer.** If machine A has seen the gate pass, the declaration is corroborated —
  the gate demonstrably can pass — and machine B treating it as unproven would be acting on
  ignorance rather than evidence. A remote observation is not stale data here; it is exactly
  the evidence §4a asks for.
  So `lastGatePassAt` is the **latest observation across the pool**, obtained by the existing
  merged-read path rather than a new replication channel.
- **Degraded behaviour is explicit.** When peers are unreachable, the local value is used.
  That can only make the corroboration window look SHORTER than it truly is, so the worst
  case is an earlier revert to `'precondition'` — more retrying, never less. The degraded
  path therefore fails toward the safe default, which is the required direction.
- **A topic/machine transfer strands nothing.** The receiving machine reads the pool-wide
  value; if it cannot, it falls back to the safe default until it observes a pass itself.

Every machine runs the identical corrected logic for the jobs it owns.

## Self-Heal Before Notify

Not applicable: no monitor, watcher, or notice source is added. §6 is recorded telemetry on
an existing read surface and raises nothing. The change **removes** notification-shaped noise
(spurious `exhausted 6 retries`).

## Frontloaded Decisions

1. **Is gate meaning inferred or declared?** **Declared** (`gateMeans`). Inference was tried
   and refuted by the corpus audit — 15 of 20 gates are health probes whose non-zero exit
   means "retry me".
2. **What is the default?** `'precondition'` — byte-identical to today. The behaviour change
   is opt-in per job.
3. **Which jobs opt in as part of this change?** The 4 audited work-presence gates,
   `insight-harvest` first (the observed victim). In scope, not deferred.
4. **Does an answered gate still retry internally?** Depends on the declaration, and this
   is deliberate: for `'no-work'`, an answered non-zero is authoritative on the first attempt
   (only `could-not-run` is re-attempted); for `'precondition'` (the default) the internal
   `gateRetries` loop is **unchanged**, all attempts, on any non-zero. A previous revision of
   this line contradicted §2a — the efficiency gain applies only to jobs that opted in.
5. **Unrecognised rejection shape?** `could-not-run` → today's retry. Conservative, stated.
6. **Does a `no-work` answer clear retry state?** Only **gate-origin** state. Execution-failure
   backoff is preserved.
6a. **What if a `no-work` declaration is simply wrong?** After `uncorroboratedAfterDays`
   (default **30 days**, elapsed time — NOT a tick count) with no observed pass, the job
   reverts to `'precondition'` and records `gate-declaration-uncorroborated`. One observed
   pass corroborates it permanently. A count-based threshold was tried and rejected: it
   re-creates this spec's own bug for a job whose work genuinely arrives rarely.
7. **Where does the telemetry surface?** Existing `GET /jobs` / `GET /jobs/:slug`. No new
   route, watcher, or cadence.
8. **Feature flag?** No. The default *is* the safe path, so a flag would add a switch whose
   off-position is already the behaviour. Per-job opt-in is the staging mechanism.
8a. **Is `gateMeans` optional?** **Required at authoring** (repo lint refuses a `gate`
   without it), **tolerated at runtime** (absent ⇒ `'precondition'`). Strict where the
   mistake is made; tolerant where the blast radius is. Shipped manifests are stamped by an
   idempotent migration.
9. **Config knobs?** None. `gateRetries` / `gateRetryDelayMs` keep names and defaults; only
   which outcomes they apply to narrows.

**Reversibility.** Not tagged cheap-to-change-after. Rollback is one revert plus removing
`gateMeans` from 4 job manifests; no migration, no persisted state to unwind.

## Acceptance criteria / controls

**Control A — a declared no-work gate skips with the ladder untouched.**
A job with `gateMeans: 'no-work'` and a non-zero gate records `gate-no-work` with retry state
unchanged. *Must-fail control:* the **same gate on a job without the declaration** must
consume a ladder rung — proving the test reads the declaration and is not merely observing a
scheduler that never retries.

**Control B — a starved job recovers its cadence.**
`insight-harvest` is driven: no-work tick → work appears → the job runs at its **next cron
window**, not a ladder rung. *Must-fail control:* the same sequence on pre-fix code must land
on a ladder rung.

**Control C — the 15 health probes are untouched.**
A health-probe gate failing with exit 7 (server down) must **still retry**, on the default
declaration. *Must-fail control:* asserting this against a build where the default is
`'no-work'` must fail — proving the test detects a wrong default rather than passing
vacuously. This control exists because getting the default backwards is the single change
that would do real damage.

**Control E — an uncorroborated declaration reverts.**
A job declared `no-work` whose gate never passes must, after N answers, resume retrying and
record `gate-declaration-uncorroborated`. *Must-fail control:* a job declared `no-work` that
passes once and then answers N times must **NOT** revert — proving the corroboration latch
works and the revert is not simply a timer that fires on every quiet job.

**Control D — telemetry is inert.**
Telemetry present vs absent must produce **identical scheduling decisions, retry
state and tick timing** (response payloads differ by design — the assertion is scoped to
scheduler behaviour, not bytes on the wire). *Must-fail control:* a job with insufficient history must
record the field as ABSENT, and a job observed never passing must record `lastGatePassAt:
null` — the two states must be distinguishable, and neither may be rendered as a bare
boolean. There is deliberately no `neverObservedPassing` flag: an earlier draft used that
name for a tri-state value, which reads as a boolean to any API consumer.

Every control pairs a must-pass with a must-fail case: a test asserting "no retry happened"
passes trivially against a scheduler that never retries anything.

## Test plan (Testing Integrity Standard — all three tiers)

The controls above state WHAT must be proven; this states at which tier each is proven.
Every tier is required; none is optional.

**Tier 1 — Unit (`tests/unit/`), `JobScheduler` with real dependencies.**
- `classifyGateRejection` over every rejection shape: numeric code, `signal`/`killed`,
  string `code` (`ENOENT`/`EACCES`), 126, 127, and an unrecognised shape → `could-not-run`.
- Routing: `answered` × `gateMeans: 'no-work'` → skip, gate ladder untouched;
  `answered` × `'precondition'` (and × absent) → ladder advances. **Both sides of the
  boundary with realistic inputs**, per the standard's semantic-correctness requirement.
- Retry-state shape: gate-origin and execution-origin ladders coexist; a `no-work` answer
  clears only gate-origin; precedence resolves to the earliest next-attempt time.
- §4a: a job never observed passing reverts after `uncorroboratedAfterDays`; a job that
  passed once never reverts (the corroboration latch).

**Tier 2 — Integration (`tests/integration/`), full HTTP pipeline.**
- `GET /jobs` and `GET /jobs/:slug` return `consecutiveAnswered` and `lastGatePassAt` with
  the specified JSON types, including the `null` (never observed) and absent (insufficient
  history) cases as **distinct** states.
- Existing consumers reading existing fields are unaffected (additive-only assertion).

**Tier 3 — E2E lifecycle (`tests/e2e/`), production init path mirroring `server.ts`.**
- A scheduler booted the production way runs a real job with a real `gateMeans: 'no-work'`
  manifest end-to-end and the feature is genuinely alive — the "is it actually wired?"
  test the standard names as the single most important one.
- The migration (§1b) runs against a fixture agent home whose manifests lack `gateMeans`,
  stamps the correct values, and is idempotent across a second run.

**Wiring integrity.** `gateMeans` must be shown to travel from the manifest on disk →
`JobDefinition` → the routing decision. A test asserting the routing function in isolation
cannot see a loader that never populates the field, which is exactly the class of defect
wiring-integrity tests exist to catch.

**Zero-Failure Standard.** The full suite (`npm run test:all`) must be green before the PR
is opened, not only the new tests.

## Standards-Conformance dispositions

Ten conformance rounds were run. Nine findings were **fixed**. One is recorded here as
**accepted with reason**, because the gate is signal-only and a signal that cannot be
satisfied should be dispositioned rather than iterated against.

**ACCEPTED — "Verify the State, Not Its Symbol": a `no-work` declaration permanently
authorises skipping, and one observed pass does not prove the declaration semantically
correct.**

This is true, and it is stated in §4a rather than hidden. The reason it is accepted rather
than fixed:

- The proposition *"a non-zero exit from THIS command means no work"* is a claim about the
  author's intent. **No evidence observable by the scheduler can settle it** — a health probe
  and a work-check are byte-identical commands, which is the audit finding that produced this
  entire design.
- The standard's actual requirement in the unmeasurable case is that the value remain an
  explicit `unknown` rather than collapse to a flattering fabricated one. It does: the spec
  states plainly that nothing verifies semantic correctness, and §6 telemetry records rather
  than adjudicates.
- Every further round of machinery narrowed the claim without grounding it. Continuing would
  add mechanism for the appearance of rigour, which is the opposite of what this standard
  exists to enforce.
- The mitigation is placed where the claim is actually checkable: §1a makes the declaration
  **mandatory and explicit at authoring**, so a human reviewer sees the assertion at the one
  moment it can be evaluated.

Disposition owner: echo. Anyone who disagrees should read §4a's "Precisely what one observed
pass does and does not establish" and overrule this in review.

## Open questions

*(No deferred work.)*

1. **Should `never-observed-passing` eventually notify?** Turning telemetry into an alert
   would add a notice source and owes the full Self-Heal-Before-Notify contract. A question
   for the reviewer — not deferred work, since nothing here depends on the answer.
2. *(Resolved — was "should `gateMeans` be mandatory?". It is, at authoring time, via the
   lint in §1a. Leaving it optional would have made the fix depend on future authors
   remembering, which is the failure this project's foundational principle exists to
   prevent.)*
