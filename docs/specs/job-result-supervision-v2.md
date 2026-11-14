---
title: Job result supervision v2 — every script result accounted for, judgment where useful
slug: job-result-supervision-v2
status: draft
owner: echo
author: echo
parent-principle: "Judgment Within Floors"
requested-by: "justin (Telegram topic 130742, 2026-10-27 19:41 PDT)"
approved: true
approval-source: "Justin explicitly supported the recommended middle-path plan and authorized implementation through deployment in Telegram topic 130742, 2026-10-27 19:41 PDT"
eli16-overview: docs/specs/job-result-supervision-v2.eli16.md
supersedes:
  - "docs/specs/job-cost-reduction.md §5.6.1–5.6.3 and dependent cost/test/rollout claims"
  - "docs/specs/job-model-routing.md claims that pass/script jobs need no result review"
review-convergence: "2026-10-28T03:09:34.982Z"
review-iterations: 6
review-completed-at: "2026-10-28T03:09:34.982Z"
review-report: "docs/specs/reports/job-result-supervision-v2-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 7
---

# Job result supervision v2

## Problem statement

Spec 1 replaced expensive scheduled sessions with scripts. Its result check is
dark pending the required benchmark and audit coverage. The design restricted
Jev to five jobs, ignored bare-OK and declared skipped results, reused a prior
model answer for repeated output, and sampled results at six-hour intervals
when Jev was unavailable. That saved calls, but the five-job boundary was an
assertion, not a measured safety result. A distinct outcome on a job outside
the list could receive no judgment. Conversely, the literal correction in draft
PR #2394 calls Jev for every identical OK line. A model seeing only OK has no
new evidence with which to detect a broken check.

Justin approved the middle path in topic 130742: every real script result must
get a **recorded supervision decision**; fixed rules handle results whose
meaning is fully known; Jev handles results needing judgment; Haiku or Luna
replaces Jev only when unavailable. Independent failure canaries and immediate
critical alerts remain. Any result the system could not check is visibly
marked unchecked. Model calls and later outcomes must be reviewable in bulk.
This explicit operator direction authorizes a narrow fixed-rule result
closure for independently certified, exact job contracts. The constitutional
exact-whole-message exception for operator commands remains unchanged; a
fixed result rule never classifies an operator message or permits a new
side-effecting action. The Standards-Conformance Gate may still flag the
structural closure as a possible conflict with that general rule; its scope,
operator authorization, and independent evidence are disclosed here rather
than silently treating the flag as a clean pass.

This spec owns after-run result supervision for all built-in script and pass
jobs, including conversions added by spec 2. It does not change the before-work
Jev gates for selected session jobs. No provider choice or claim of savings is
made without the job-shaped benchmark and post-rollout measurements.

## Proposed design

### 1. One decision record for each result

For each completed production script run, the scheduler writes one logical
supervision record keyed by a collision-resistant **attempt ID** (UUIDv7 or a
persisted monotonic sequence plus random machine namespace). A scheduled fire
has a separate logical fire ID, so a claim transfer creates a new attempt
without silently merging two outcomes. Conflicting payloads for one attempt ID
are refused and audited, never overwritten. Result means parsed `success`, `failure`,
or `skipped`, plus script start/verification errors and timeout. The record
starts **before execution**: the scheduler durably registers the attempt and
claim/fire ID before launching the script. If this write fails, it does not
launch. Recovery reconciles every registered attempt against the claim and
executor lifecycle, including a crash after execution but before either
completion append. An irrecoverable completion is `unchecked:outcome-unknown`
in the denominator; recovery never re-executes a side-effecting script merely
to reconstruct its result. The first transition is `attempt-registered`.
Completion appends `result-recorded` under the same attempt ID, or recovery
appends `outcome-unknown` when completion cannot be reconstructed. The record
contains the job slug, template/version digest, run result, evidence-policy
version, choice of `fixed`, `jev`, `replacement`, or `unchecked`, reason,
provider/model if a call happened, the resulting session admission outcome,
and links to the call audit and later outcome grade. An internal must-fail
canary is recorded in a separate durable canary-assertion log with its
assertion result; it is never counted in the production-run denominator,
sent to Jev, or allowed to start a session. The current canary runner **does**
write `JobRunHistory` rows with `trigger: script-canary`; the production census
includes `runner: script` with scheduled, queued, manual, missed and retry
trigger families, while explicitly excluding `isSideRun()` canaries and
triage-origin runs. The assertion log is written by
the canary runner. Its failure reaches the existing alert path. Trust-rejected output is not
parsed as evidence; its safe status-only exception is
`unchecked:script-untrusted` with an immediate failure alert. It is not a
certified routine shape. No raw output is in the supervision ledger.

The canonical lifecycle status is separate from provider choice and verdict:

| Current status | Event | Next status |
|---|---|---|
| `pending` | Certified fixed result or model `routine` verdict | `resolved` |
| `pending` | Model `needs-session` / `cannot-tell`, or floor-required diagnosis | `unresolved` |
| `pending` | Missing/untrusted evidence, provider/queue failure, or audit refusal | `unchecked` |
| `unchecked:transient` with intact verified evidence | Retry lease acquired within 24 hours and three attempts | `pending` |
| `unchecked:transient` | Retry limit or 24-hour window exhausted | `expired-unchecked` with original reason |
| `unchecked:violation` or `unchecked:outcome-unknown` | No model retry; separate census repair/alert path | Remains `unchecked`, then ages to `expired-unchecked` with original reason |
| `unresolved` | Isolated diagnosis returns usable linked finding | `resolved` |
| `resolved` | Independent grade later proves correct/incorrect | `resolved`; grade changes and certificate may revoke |

`expired-unchecked` is terminal for automated retry, never a success. Only
provider and queue failures with an intact verified evidence
projection are retry-eligible. Trust, parser, digest, truncation, scrub
refusal, and outcome-unknown cases cannot enter a model worker. Repair may
restore trusted evidence only through a new verified result event, never by
re-running the original side-effecting script. Each provider attempt is an
immutable, separately audited call. A model verdict that asks for a
session is `unresolved` until the session actually starts and returns a
usable outcome. A cooldown, daily cap, admission refusal, or inconclusive
session leaves it unresolved and outside the reviewed/accuracy numerator.
`investigated` is the investigation dimension's value when isolated diagnosis
returns a usable, independently
gradable finding; it contributes to decision coverage only when the original
supervisor verdict and that finding are linked. The underlying incident
remains open until separate authorized remediation and an independent health
check verify recovery. A completed diagnosis without independent outcome
evidence has `outcome: unknown`, not assumed accuracy.
The record is durable before a result can be called reviewed. A queue failure,
scrub refusal, provider outage, cap, timeout, process restart, or shutdown
leaves `unchecked:<reason>`; only transient provider/queue failures with
verified evidence receive bounded model retry within a 24-hour window.
At most three provider attempts run per result. Exhausting
either limit makes the item `expired-unchecked` and raises attention. Detailed
scrubbed records are retained for 90 days by default; a minimal attempt
ID/time/slug/status/original-reason tombstone and aggregate coverage count
remain permanently
so aging cannot improve reported historical coverage.
An unchecked or unresolved result appears in `GET /jobs/triage`
and the daily review with counts, age, and reason. No dashboard or report may
count it as a successful check. A queue overload cannot silently discard a
run. The scheduler appends its `result-recorded` transition synchronously in the
script-completion path **before** releasing the claim, then enqueues only the
model work. The existing `JobRunHistory` is the independent census: at boot,
every 30 seconds, and before a coverage report, a bounded reconciler compares
completed run IDs with supervision rows and inserts `unchecked:missing-record`
for gaps. If the supervision append fails but run history succeeds, the API
counts the missing row directly from run history as unchecked until repair. If
the run-history append itself fails, the scheduler fails the fire, halts future
script fires for that slug, emits a durable local failure alert and attempts
repair from the acquired claim and scheduler fire log; reporting is marked
`coverageIncomplete` until the independent census is restored. A crash after the row but before queue
enqueue is recovered by scanning durable pending rows at boot. The supervision
store uses Instar's existing local SQLite substrate: WAL with full synchronous
durability, a unique attempt ID, an append-only transition table, and
compare-and-set updates of status and provider epoch in one transaction. The
worker lease, retry counter, route generation, and a **pre-call audit row**
(decision-point ID, prompt/version hash, evidence-policy hash, intended provider,
attempt epoch, timestamp) join that transaction **before** any provider call.
If the transaction fails, no call starts. The settled call row later records
actual served model, latency, tokens/cost, verdict and outcome link. A failed
settlement append marks the result unchecked and the audit coverage incomplete;
boot reconciliation repairs it from the provider-attempt journal where
possible, never inventing a successful verdict. After crash, expired leases
are reclaimed without duplicate settlement. `BoundedJsonlAudit` is a derived
convenience log and cannot satisfy mandatory per-call audit. Reconciliation
has its own lag and error metric;
if it cannot scan the whole reporting window, the coverage report is marked
incomplete rather than showing a favorable denominator.

The bulk view keeps four separate dimensions: provider choice (`fixed`, `jev`,
`replacement`, or none), verdict (`routine`, `needs-session`, `cannot-tell`, or
none), investigation (`not-needed`, `requested`, `started`, `investigated`, or
`blocked`), and independent outcome grade (`correct`, `incorrect`, or
`unknown`). **Decision coverage** is the number of `fixed:routine`, settled
`jev/replacement:routine`, and `resolved` records whose investigation dimension
is `investigated` with a linked initial verdict and usable diagnosis, divided
by all registered production attempts.
An initial `needs-session` or `cannot-tell` answer counts in separately
reported **initial-verdict coverage**, but not decision coverage until a
usable diagnosis returns. Unresolved and unchecked are excluded from the
decision-coverage numerator. **Investigation completion** is investigated
investigations divided by requested investigations. **Accuracy** is correct
grades divided by correct plus incorrect grades, always shown with the
gradable fraction and unknown count. The 60-second target measures time from
script completion to the **initial model verdict** for judgment-routed runs,
including `needs-session`. Investigation-resolution age and p95 duration are
reported separately with the unresolved count; initial-verdict success never
counts a pending diagnosis as resolved. The live 30-second trip controls
initial-verdict latency. Unknown completion time is excluded from latency
and counted as unchecked.

### 2. Fixed decisions need proof, not a five-job list

Each job may declare a **versioned, exact** set of result shapes whose meaning
is fully determined by local code. A fixed decision requires all of these:

1. The run came from a verified script/template digest and parsed with the
   declared schema. Unknown fields, new reason codes, changed summary shapes,
   truncated output, or parser errors fail the fixed check. The digest and
   relevant feature-state values are captured at run start and bound to the
   result. The certifier checks that snapshot, not mutable current config.
2. There is no anomaly, unexpected side effect, failure, timeout, or new
   operator-facing text. The known result has a declared owner and an explicit
   result-to-action rule. A declared skipped reason must be proven intentionally
   safe for that job and current feature state.
3. The decision is covered by tests on both sides of the boundary, a must-fail
   canary where the job can falsely report healthy, and a live shadow sample
   reviewed against later outcomes. An unsupported or newly converted job
   defaults to `needs-judgment` until that evidence exists.

Only allowlisted normalized fields participate in shape classification;
upstream prose, timestamps, random IDs, and fluctuating provider values are
treated as untrusted evidence, not as a new shape name. Unexpected fields
still route to judgment, but cannot create unbounded registry entries. Only a
bounded reason code and hash of a rejected field enter the ledger; its value
is never sent to a model unless the job's explicit evidence policy allows it.
An ordinary new schema field, changed summary, new reason code, or uncertified
shape is a **judgment result**, not a rollback trigger. Failed parser integrity,
template digest mismatch, trust failure, output truncation/over-cap, failed
canary, and confirmed false routine results are **contract violations**. They
disable the affected slug's new script route for future fires (the exact
certificate is revoked for a false routine miss). Trust rejection, parser
integrity failure, digest mismatch, and truncation leave the current attempt
`unchecked:<violation>` because evidence is missing or untrusted; a separate
violation flag drives rollback and alert. A confirmed false routine decision
remains in the accuracy denominator as an incorrect grade.
**Evidence sufficiency is independent of provider choice.** An uncertified
status-only OK or skipped result with no independently checkable facts cannot
be closed as routine by Jev, a replacement model, or fixed rules. It enters
`unresolved:evidence-insufficient`, requests isolated diagnosis against a
fresh independent diagnostic snapshot, and sends future fires through a
budgeted prior runner until the shape is certified. If no independent probe
can verify the current result, diagnosis remains unresolved and operator
attention is raised; model confidence alone never supplies the missing
evidence. A judgment result may receive a model verdict when it has a
verified anomaly/failure signal or a fresh corroborating signal from an
independent subsystem (captured within ten minutes, bound to the run, and
not written by the script being judged). Routine closure still requires that
independent corroboration, or a fixed certificate. The evidence-sufficiency
predicate is a tested code-owned floor before model settlement, not an
instruction in the prompt.
These are **eligibility invariants** for a local job-result contract, not a
probabilistic verdict about ambiguous content or a classifier for operator
commands. The separate operator-command enumeration standard remains exact
whole-message matching and is unchanged. The rule yields `fixed:routine` only for an exact certified
shape. Every other trustworthy, complete result goes to Jev; contract
violations follow the hold/rollback table. A verified critical anomaly and a second
consecutive failure have a separate **session floor** and immediate alert rule:
Jev may add a session but cannot remove a required one. A known OK string is
not proof that the script is healthy; daily must-fail canaries test that the
script still detects a simulated failure. The canary's limits are reported
honestly: it does not prove every real-world fault is detectable.

The rollout measures fixed decisions by slug, shape, and version. It compares
sampled fixed outcomes with historical or counterfactual analysis of the old
session path, never by rerunning a side-effecting job. A shape can become
`certified` only through a reviewed, versioned artifact naming its schema,
owner, at least 300 observed outcomes and 300 independently gradable outcomes
per common shape (all available outcomes for a rare shape, which remains
judgment-routed until it reaches 300), zero confirmed missed actionable
results, and the test/canary evidence. Low-volume or ungradable shapes remain
judgment-routed. The certificate is checked at deployment, not inferred from
a config flag. Any confirmed false routine result revokes that exact shape.
The certificate is signed by the job owner and an independent reviewer; the
revocation is written by one pool authority to a durable replicated
versioned registry and is checked synchronously before a fixed decision on
any machine. A revoked shape, stale certificate, or unreadable authority is
**not** repaired by asking Jev to judge the same empty OK string. The completed
result remains unresolved, the independent canary/alert path runs, and future
fires use the prior full-session runner. If no prior runner exists, that slug
is held and the operator receives an immediate attention item. After a
claim transfer, the new owner applies the same registry epoch. A corrected
shape needs a new certificate; clearing a local flag cannot restore it.
Continuing surveillance independently grades a stratified 10% of fixed
closures each rolling seven days (at least 10 per active shape, or every
closure if fewer than 10). Grades are due within 48 hours of the sampled
outcome becoming available. A shape is suspended if the window's required
sample is missed, outcome evidence is unavailable for 14 days, or any
confirmed false routine result appears. A suspended shape cannot close new
results with a fixed rule; a new reviewed certificate is required after
sufficient evidence recovers. A suspension uses the revoked-certificate
runner rule: future fires use a reserved prior runner or are held; Jev does
not certify the same bare OK text. Sample selection, due dates, grades, misses, and
suspension are visible in bulk review. The sample is **quality surveillance**,
not the sole check for a result that already needs judgment.

### 3. Jev is the first judgment provider

For each result marked `needs-judgment`, send one bounded, scrubbed evidence
projection to Jev. The projection contains structured result, reason codes,
anomaly kinds and allowed fields; a free-text tail is sent only where the
job's privacy policy explicitly permits it. Fleet-user report text, mentor
subject internals, credentials, and private-key markers never leave through
this path. Scrub failure becomes `unchecked:evidence-withheld`; deterministic
alerts still fire. Output is quoted as untrusted data, never instruction.

Jev answers `routine`, `needs_session`, or `cannot_tell`, with forward and
reverse criteria. A confident routine verdict can close only a result that has
no floor-required session. Uncertainty, malformed response, or order conflict
requests a bounded investigator session. The current fixed prompt, tool
confinement, no-credential environment, session cooldown, episode dedupe,
per-slug and daily caps remain. A cap refusal leaves the run `unresolved`,
is retried or escalated by the supervision owner, and is recorded on the
open episode; the critical alert is unaffected. A Jev verdict alone is not
proof an investigation occurred.

An automatic investigator receives **only trusted structured fields and
fixed code-owned instructions**, never the job's free-text output or raw run
history in its prompt. Automatic launch requires an OS/container boundary
that mounts only a generated, read-only diagnostic snapshot for that attempt,
with no agent home, config, secrets, run history, vault, network, or MCP access;
the launcher attests these restrictions in a real launch test and fails closed
if they are absent. A prompt allowlist, empty credential environment, or
Codex's unsupported `--allowedTools` flag is insufficient. If the effective
boundary cannot be enforced, the result stays
`unresolved:investigation-unavailable` and raises one deduplicated operator
attention item; it does not spawn an agent with wider access. Any data later
read by an admitted investigator remains untrusted. The isolated investigator
may diagnose only; it cannot remediate live state. A separate guarded
remediation session may be proposed through the existing operation gate, with
explicit authority and audit, or the operator handles the issue. A floor-required
session guarantees the bounded diagnostic request and alert, never an implicit
grant of live mutation access. The investigator cannot turn its own analysis
into proof that the initial result was safe or the incident healed.

Repeated identical evidence is still a **new result** and gets a new
supervision record. Deduplicating a Jev call is allowed only as a measured
optimization after shadow evidence shows the omitted calls do not miss
meaningful changes in context; the default here is no model-verdict reuse.
The proof must include streak and episode changes across identical output.

### 4. Replacement only when Jev is unavailable

Unavailable includes no key, disabled route, timeout, wrong served model,
breaker open, or Jev daily cap. Haiku or Luna replaces Jev for **every result
that was marked needs-judgment**, subject to the same evidence policy and
session floor. It does not provide routine second opinions while Jev works.
The replacement can group non-urgent results by slug in a short bounded batch,
with a verdict per run ID and no unreported unread tail. Critical alerts and
floor-required session requests proceed immediately and do not wait for a
batch. A batch that times out or omits a run leaves that run `unchecked`.

The replacement provider is chosen from current job-shaped benchmark evidence
that shows it performs better than the deterministic floor for this decision.
An unbenchmarked model is never given supervision authority. On an agent with
only one provider and no such evidence, the safe fallback is the prior full
session runner for **future** fires of that job, not an unproven cheap model;
completed script results stay visible as unchecked/unresolved and are not
re-executed. This preserves one-provider functionality. No metered door is
selected unless the operator has explicitly enabled it. When no provider is
reachable, the fixed alert/session floor still works and the result remains
visibly unchecked. Daily cost caps protect quota but never relabel an
unchecked run as routine. Recovery of Jev makes older unchecked judgment
results eligible again before fresh routine work. Each result has a durable
single-flight lease and monotonic provider-attempt epoch, acquired by compare
and set before any call. A timeout may start a replacement at the next epoch;
only the current epoch may settle the verdict or admit an investigator. A late
Jev answer is retained as audit evidence only. Lease recovery after restart
uses the same rule, so workers cannot commit competing decisions.

The worker uses a durable pending queue reconstructed from the ledger. Its
active in-memory set holds at most 2,000 entries per machine; the durable
backlog can exceed that ceiling and is scanned oldest-first in bounded pages
whenever a slot opens. It never drops an
over-cap result: the run ledger records `unchecked:queue-overload` and the
new script route stops admitting future fires until the backlog falls.
Queue overload is classified **recoverable**. A thin `SelfHealGate` over the
existing P19 breaker first reclaims expired worker leases and drains bounded
pages from the durable backlog (at most two attempts, at most 60 seconds,
10-second backoff, deduped by machine and overload episode). Each attempt is
idempotent by the per-result epoch; a partially claimed item is compensated
by lease expiry and compare-and-set retry. The scrubbed metadata trail lives
in `logs/job-supervision-heal.jsonl`. If the backlog remains over the limit
after those attempts, one attention item is raised. A five-minute latency
backstop raises it even if a heal is still running, and a second overload
episode within an hour escalates as flapping. An irrecoverable lost census,
security/trust violation, or confirmed false routine result alerts on the
detection tick while repair proceeds concurrently. Jev retains the existing
1,500-check daily cap and serial lane. Replacement batches at most 12
non-urgent results of one slug, waits at most 10 seconds to fill, and has
hard limits of 100 calls and 250,000 input tokens per machine per day. These
are ceilings, not a claim of adequate capacity. The **whole-route** budget
also counts **active-cohort** fallback full sessions through a new pool-authoritative daily
reservation ledger: at most 24 routine fallback sessions per slug and 120
across the pool, with 10 additional critical reservations. Reservation is an
atomic compare-and-set at the pool authority and also requires existing
quota and work admission. If the authority is unreachable, routine fallback
admission fails closed; a critical alert still fires. A fallback session needs
the reservation before its fire is admitted. When that budget is exhausted,
routine future fires stay on the deterministic script path **only when both
rollout gates remain open**, with an `unchecked`
record and one deduplicated operator attention item. Critical alerts are
unconditional. Required diagnostic investigations use their separate triage
admission caps (six per machine and three per slug per day by default), not
the ten critical **prior-runner** reservations; if diagnostic admission is
refused, the incident remains open with urgent attention. This deterministic mode is
permitted for provider/queue degradation only; a revoked or unreadable
fixed-shape certificate holds the affected slug rather than trusting its
script OK output. No unbudgeted burst of
old full sessions is permitted, and this degradation is shown as reduced
supervision rather than claimed as full coverage. The test-agent and shadow
stages measure arrivals, p95 decision lag and actual provider cost. Active
rollout requires 99% of judgment results to receive a verdict within 60
seconds in the measured workload, zero unreported gaps, and no sustained
queue growth. At runtime, the route closes to **new supervised script fires**
when the oldest non-urgent pending result reaches 30 seconds or the measured
single-flight service rate predicts any pending result will exceed 60 seconds;
Jev calls time out by 15 seconds. The gate is rechecked on each enqueue and
every five seconds. Existing urgent backlog bypasses batching and takes the
25% **provider scheduling** reserve immediately; older non-urgent items remain visible and are
drained oldest-first. For provider or queue degradation while both rollout
gates remain open, future fires use the budgeted prior runner; once its budget
is spent, a certified healthy script may run in the explicitly marked
deterministic unchecked mode. Queue selection reserves
25% of available calls for anomaly-bearing results and uses round-robin
fairness across slugs; an attacker varying upstream text cannot consume every
slot. Oldest unresolved work within each priority band runs first. Retry is
bounded to three attempts with exponential backoff across restarts; a run
still unresolved after 24 hours raises attention and remains in the
denominator. No result is ever marked reviewed merely because its retry
window expired.

### 5. Benchmark, audit, and quality gate

No new model call path activates until it has a stable decision-point ID,
prompt/version identity, actual provider/model, time, tokens/cost where
available, evidence-policy version, result ID, structured verdict, and
later outcome link in the existing decision-quality/benchmark system. Unknown
outcome is recorded as `unknown`, not success. The bulk review reports the
fixed/jev/replacement/unchecked mix; false routine decisions; unnecessary
sessions; latency; egress refusals; and quota use by job, model, prompt and
machine. It also reports decision coverage and a denominator of **all script
results**, so missing records cannot make accuracy appear better. Call records
for retries, fallbacks, referee calls, and shadow samples follow the same rule.

The current code-owned `JOB_COST_AUDIT_READY.resultTriage` gate stays false
until benchmark tasks, outcome grading or explicit unknown, bulk query, and
three-tier tests prove the path. A saved config value cannot turn it on early.
Audit readiness is **not** the rollout switch: a second code-owned cohort
gate (`test-agent`, `development-agent`, `fleet`) controls new runner admission,
fixed decisions, Jev, replacement, and investigator admission. The
**record-only spine** (pre-execution attempt registration, census,
reconciliation, and unchecked reporting) is required for every production
script execution regardless of these decision gates. If its durable attempt
write cannot be made, the script does not launch and the scheduler follows
the prior-runner/hold rule. The existing config default `jobs.scriptTriage.enabled: true`
cannot activate fleet triage by itself. Opening audit readiness for a test
or development agent leaves all fleet agents on the previous runner. The
cohort gate and its effective value are visible in the status API and bulk
report. Existing user config values are preserved on migration.
Spec 2's benchmark routing pins remain a separate gate.

### 6. Rollout and rollback

First, run the new decision pipeline on a **supervised throwaway test agent**
with simulated job inputs and no live scheduled jobs or third-party egress.
Then run it in **shadow** on a development agent using recorded production
results of already-converted scripts or non-executing replay of historical
results. A scheduled fire executes one runner only; shadow never reruns a
side-effecting script or opens a second session. No new third-party evidence
is sent. Measure the actual distribution of
result shapes and confirm the fixed registry against historical and later
outcomes. Then enable active Jev on the development agent with TypeSafe
egress acknowledged and the full audit path working. Test a real Jev outage
and observe the replacement's per-result coverage, latency, and cost.
Publish a before/after week: sessions avoided,
Jev and replacement calls, total weighted tokens and metered spend, missed
problems, false alerts, unchecked count and age, and one-provider results.
Only then consider fleet activation through a separate reviewed cohort gate.
The fleet rollout requires the same evidence, user-visible egress notice,
and an explicit reviewed migration. A confirmed missed actionable result,
contract violation, audit gap, or budget surprise closes the affected slug's
new model route and restores the
previous job behavior within the explicit fallback-session budget; after
that budget, affected fires are held with attention. The local
deterministic critical alert path remains.

The existing agent-installed config migration adds only missing defaults;
existing user values are preserved. Template metadata and generated shadow
instructions are updated through the normal migration path. Re-running the
migration is idempotent. Runner selection is atomic per slug for **future**
fires and bound to the acquired claim. This precedence table is authoritative
for rollback and admission; a completed fire is never re-executed.

| Condition at admission | Future fire | Completed attempt |
|---|---|---|
| Cohort never activated on this executor | Preserve prior runner and its existing admission policy; new fallback budget does not apply. Existing script runs still use the record-only spine. | Keep recorded result and alert |
| Previously active cohort deliberately rolled back or audit gate fails | Prior `agentmd` with a new-route fallback reservation; after budget exhaustion hold and alert. A closed gate never authorizes a new script route. | Keep recorded result and alert |
| Jev/replacement unavailable or queue/SLO gate closed | Prior `agentmd` with reservation, then deterministic visibly unchecked script after budget exhaustion if the script certificate is healthy | Retry bounded pending judgment; keep unchecked if exhausted |
| Ordinary uncertified or new result with intact parser/template trust and independently checkable facts | Continue the current runner; route this result to Jev or outage replacement. No automatic rollback. | Keep its judgment record |
| Uncertified status-only OK/skipped result with no independent facts | Future fires use reserved prior runner until shape certification, then hold if budget exhausted | `unresolved:evidence-insufficient`; isolated diagnosis or operator attention, never model-routine closure |
| Fixed certificate revoked or suspended, registry unreadable, or canary fails | Hold affected script slug; use prior `agentmd` only with reservation and valid definition, otherwise hold and alert | Unresolved; independent alert/canary path continues |
| Parser integrity, template digest, trust, or truncation violation | Disable affected slug's new script route; use reserved prior runner or hold and alert | `unchecked` with violation reason; never send incomplete evidence to Jev |
| No verified prior `agentmd` definition | Hold slug and alert; never invent a fallback | Preserve original record |
| Critical floor while all session reservations are spent | Keep independent immediate alert; hold mutation-capable work and mark diagnosis unresolved | Never label routine |

The deterministic unchecked mode executes only when both code-owned rollout
gates are open and the script implementation and canary remain certified
healthy; it is a visible degradation of AI
supervision, not a successful rollback or reviewed result. If the script
itself is suspect, the hold rule wins. The switch, reservation refusal, and
hold reason are audited and exposed. Durable supervision records and alerts
remain for review.

Two session types stay distinct: a **diagnostic investigation** is a new,
snapshot-only session requested after a result and charged to the existing
triage per-slug/per-day diagnostic caps. A **prior-runner execution** runs the
job itself as `agentmd` on a future fire, under the active cohort's fallback
reservation cap (or legacy admission on a never-enrolled executor). Neither
counter can be borrowed to exceed the other. A floor-required diagnostic
request never authorizes a second execution of the same fire.

## Multi-machine posture

The logical scheduled fire ID and attempt ID are unified across machines;
the script runs on the executor that held the claim, where its provider
credential physically resides. Each machine writes its local audit and
result record; `GET /jobs/triage?scope=pool` merges them by attempt ID and
shows an explicit `coverageIncomplete` flag for unreachable, absent, or
old-version peers. The expected roster comes from authenticated pool
membership, including peers seen within seven days; absent peers remain
listed until their run history is reconciled or membership explicitly retired.
A partial pool cannot report a complete accuracy percentage. The
pool-authoritative fixed-shape certificate/revocation registry is replicated
and checked fresh before any machine closes a result with a fixed rule; a
partition prevents fixed closure and sends future fires through the prior
runner. A runner choice is bound to the **acquired claim** as a route
generation and immutable per-fire choice before execution. Only an executor
advertising support for that generation may acquire or receive the claim;
an incompatible peer is excluded from the claimant set. A transferred claim
inherits the choice. No transfer or alternate-runner substitution is allowed
after execution starts; if the executor disappears, its pre-registered attempt
becomes outcome-unknown and any next fire gets a new claim. A new generation
applies only to later fires. **Active rollout is held while any expected executor lacks
the record-only spine, route-generation claim support, or pool reservation
client.** Old-version sessions continue under their legacy admission policy
and are reported separately; no total pool-budget or coverage claim includes
them. The 24/slug and 120/pool cap applies to upgraded active-cohort fallback
sessions only, with the pool authority's atomic ledger as the common counter.
Each slug is eligible for active rollout only if a verified
prior `agentmd` definition exists on every executor; otherwise the slug is
held with operator attention until a safe fallback is installed. Session cooldown and episode dedupe consult the
pool before admission. If the peer read fails, the local admission bound
decides and the possible duplicate is recorded, never hidden. A failure
streak spans logical job attempts across the pool: if the predecessor cannot
be read, a current failure conservatively satisfies the session floor.
Operator notices use the existing one-voice channel.

## Maturation plan

- **test-agent-live:** supervised throwaway agent with simulated job inputs,
  all three test tiers, actual launch isolation proof, planted sensitive
  output, provider timeout, certificate revocation, provider settlement race,
  and zero unsupervised production jobs.
- **dev-agent-live:** development agent shadow on recorded results, followed
  by guarded active Jev with TypeSafe egress acknowledged and the per-call
  decision-quality audit proven. Run a real outage trial, then measure seven
  days of fixed/jev/replacement/unchecked distribution, latency, false routine
  results, diagnosis completion, session cost and one-provider operation.
- **fleet:** separate reviewed cohort-gate migration after the development
  evidence and all expected executors support record-only attempts, claim
  generations, and pool reservations. Existing agent config values remain.
- **graduation criterion:** zero unreported attempts; 99% of judgment results
  receive an initial verdict within 60 seconds; zero confirmed false routine
  closures; all sampled fixed closures graded on time; no sustained backlog;
  replacement quality at least the benchmark floor; cost and one-provider
  behavior measured against the old route. A zero-run window is not a pass.
- **dark-window:** within 21 days after merge, publish the development trial
  result and a fleet decision or a dated remediation commitment. The model
  path stays dark until its benchmark and audit gates pass; no silent
  indefinite dark state counts as completion.

## Decision points touched

| Decision | Class | Floor and arbiter |
|---|---|---|
| Is the result record present and structurally valid? | invariant | Run history is the independent census; one keyed state machine per collision-resistant attempt ID; missing or malformed is `unchecked`, never routine. |
| Is an exact result shape certified fixed? | invariant | Versioned schema, run-start snapshot, reviewed certificate, two-sided tests, canary and shadow evidence; a mismatch routes to judgment, while revocation or stale epoch holds the result unresolved and moves future fires to the prior runner. This is a finite declared contract, not a score. |
| Does a result need diagnostic investigation? | judgment-candidate | Critical anomaly/pool-wide second failure floor; Jev arbiter over bounded evidence; uncertain asks for snapshot-only diagnosis where actual runtime isolation is verified; otherwise unresolved plus attention. This does not re-execute the job. |
| Which provider checks a judgment result? | invariant | Jev while available, replacement only on enumerated unavailability; no dual decisions on one run. Current benchmark evidence chooses replacement model; absent evidence keeps the old runner for future fires. |
| Can a session be admitted? | invariant | Existing cap, cooldown, episode and work-admission checks; refusal recorded and critical alert unaffected. |
| Is a fixed shape still safe after a false routine result? | invariant | Any confirmed miss revokes that exact shape through the pool authority; no machine may use a stale epoch. |
| Is new supervision active on this agent? | invariant | Code-owned audit-readiness and cohort gates both true; a config default alone cannot activate fleet behavior. |
| Can the new script runner continue under degraded supervision? | invariant | Provider/queue trip uses reserved prior-runner executions, then visibly unchecked certified scripts while both rollout gates remain open; closed gates or suspect scripts hold after budget exhaustion. Completed attempts are never rerun. |

## Tests and evidence required

- **Unit:** both sides of every fixed shape; unknown field, changed summary,
  canary failure, uncertified bare OK/skipped with no independent signal,
  truncated output hiding an anomaly, repeated output with changed streak, pool claim move,
  run-ID collision and conflict, stale feature snapshot, revocation while a
  peer is partitioned, critical floor, scrub refusal, Jev uncertainty and
  criteria disagreement, outage/race, cap and recovery, backlog starvation,
  novelty flood and fair scheduling, malformed replacement batch, unbenchmarked
  one-provider fallback, and runner rollback.
- **Integration:** a real scheduler-to-HTTP pipeline writes one record per
  production run and exposes pool-wide fixed/jev/replacement/unchecked and
  unresolved counts. Crash at each completion/claim-release/enqueue boundary,
  abort, timeout, trust rejection, provider failure, and partial peer read do
  not disappear from the run-history denominator. Canary assertion failures
  reach their own alert and audit path.
- **E2E lifecycle:** production initialization enables the feature only after
  both the code-owned audit gate and cohort gate are certified; routes return
  200 with live injected dependencies, not 503. An inactive fleet install
  keeps the prior runner even when audit readiness is open for development.
- **Wiring integrity:** actual server dependencies, audit store and provider
  delegates are non-null and non-noop. Benchmark/audit coverage is asserted for
  every new call path and its retries/fallbacks.
- **Rollout evidence:** supervised test-agent proof, measured shadow confusion
  matrix and per-shape certificate, outage replacement coverage and latency
  under sustained load, one-provider proof, before/after cost, and a reviewed
  bulk-quality report. No unmeasured savings percentage is claimed.

## Frontloaded Decisions

- **F1:** Every real script attempt is registered before execution and
  reconciled with run history into one keyed supervision state machine;
  missing or unknown outcomes are visibly unchecked. Fixed decisions are
  allowed only for exact certified shapes; ordinary complete, trusted unknown
  shapes go to Jev. Run IDs are collision-resistant and claim moves are
  distinct attempts.
- **F2:** Jev is first for judgment results. Haiku/Luna replaces it only while
  unavailable; non-urgent calls may batch briefly without losing per-run
  verdicts. No silent six-hour sample.
- **F3:** A critical alert is independent and immediate; a model can add but
  not remove a floor-required diagnostic request. Uncertainty asks for
  bounded, isolated diagnosis, not job re-execution.
- **F4:** Egress is per-job and structured by default. Sensitive free text is
  withheld. Audit-readiness and whole-path cohort gates stay code-owned.
- **F5:** Fixed shape certification requires reviewed test and shadow evidence;
  a confirmed miss revokes that shape pool-wide. The old five-job list is not
  a rule. An unavailable revocation authority leaves the result unresolved;
  future fires use the reserved prior runner or are held with attention.
- **F6:** Rollout proceeds supervised test agent → development shadow →
  development active → measured week → separately reviewed fleet activation.
  Never-activated executors preserve legacy behavior. An active cohort's
  failed audit gate uses budgeted prior sessions then holds; a provider/queue
  outage may use visibly unchecked certified scripts after that budget, while
  a suspect script is held.

## Open questions

*(none)*
