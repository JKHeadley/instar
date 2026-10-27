# Side-Effects Review — Job cost reduction

**Version / slug:** `job-cost-reduction`
**Date:** `2026-10-26`
**Author:** Echo
**Second pass:** GPT-6 Astra design review (topic 130742)

## Change and decision points

The scheduler can run signed built-in job scripts, parse their bounded result
protocol, and supervise their results through a deterministic floor, Jev triage
and a slower outage replacement. Anomaly episodes, canaries, a daily review,
and per-job cost reports provide checks on the conversion. The script runner is
development-agent gated; the fleet keeps the current session path. On
development agents, the default first wave is only
`llm-decision-grading` and `correction-class-review-backstop`, with the
`script-job-supervisor` observing them. Other converted slugs use their
existing session path until a later migration removes them from
`jobs.scriptRunners.disabledSlugs` after the 48-hour review.

Decisions that affect work or messages are:

- Script admission validates the signed lockfile and script hash, then applies
  the live rollout flag and per-slug exclusions.
- The result parser accepts only the declared protocol; unknown fields and
  untrusted results do not become model instructions.
- The anomaly observer opens episodes before asynchronous notification. It
  sends critical reasons on the observed run, and recoverable reasons through
  the persistence and recurrence rules.
- The triage floor starts investigation for a critical anomaly or second local
  failure. Jev may add investigations; an unsure Jev answer starts one. A
  slower model replaces Jev only during an outage.
- Every investigation passes the common admission checks and daily caps,
  including concurrent floor, backup, cascade and heal requests.
- The canary fails on a job that spuriously reports success, and the daily
  review reads bounded results and outcomes.

## Over-block and under-block

The rollout gate initially retains sessions for 15 converted jobs on
development agents. This delays most token savings until their scripted runs
pass the stated observation periods. A signed script template that does not
match its script hash is refused, even if its body could have run as a legacy
session; that is deliberate because its code has not been authorized.

Jev can still miss a noncritical concern with a confident routine answer. The
deterministic floor cannot cover every prose-level anomaly, so the daily
canary and review remain necessary. During a Jev outage, the replacement runs
at most once per six hours and samples at most 12 distinct routine results per
slug. It cannot claim complete coverage of every run. A missing TypeSafe key,
quota cap or model outage can leave routine results without model triage;
the floor, script verdicts, anomaly alerts and audit continue.

## Level of abstraction and authority

The runner gate is in the scheduler's existing admission path; migrations and
installers deploy the same built-in scripts and signed manifest. The triage
floor is deterministic for known failure conditions, while Jev handles the
open-ended result question. A Jev routine verdict never removes a floor
decision. Model outputs cannot widen the script trust gate or the session
allowlist.

The result is a signal about whether investigation is warranted. Session
admission retains independent authority over capacity, quota, cooldown and
tool access. The daily review is observational; it does not erase an alert or
approve a model pin.

## Interactions and external surfaces

- Built-in job files are replaced by the normal update installer; user job
  forks are reported but not rewritten. The rollback flag is read at trigger
  time and projects the unchanged body into a bounded session.
- Telegram anomaly delivery uses the existing automation reply and tone gate.
  A blocked message uses a fixed sentence and, when allowed, a private-view
  link. An unconfirmed send remains pending with bounded retries.
- The Jev call goes to TypeSafe only when its dev gate is enabled and a key is
  available. The outage replacement uses a separate single-flight model slot.
  A shared in-process ownership decision prevents either a new Jev request or
  a backup pass from starting while the other owns the lane.
- `/jobs/cost` and `/jobs/triage` are authenticated read surfaces. Cost
  baselines are frozen explicitly or after seven days of collection. Pool
  reads are bounded and do not follow redirects with a bearer credential.
- Agent awareness and migration entries describe the new routes, trigger
  behavior, rollback and job template keys.

## 6b. Operator-surface quality

The Jobs detail view keeps the existing Run Now and enable control at the top.
For a script job, a small read-only card follows the status card: how it runs,
its last result, seven-day tokens versus its available baseline, and one-day
triage decisions and sessions. Session jobs do not get this extra card. The
primary job action remains first and no destructive action was added.

The card uses plain labels and values rather than raw protocol fields or audit
JSON as its main content. A missing baseline says "no baseline yet" and an
unavailable optional API simply omits that row. The actual triage API returns
per-slug counts, not a decision list; the first dashboard draft would have
misreported active triage as zero. The card now reads those per-slug totals,
and a focused test checks the shipped dashboard helper against a response
whose bounded recent list omits the target job. The card's right-hand values
wrap at narrow phone widths and remain secondary to the job status and action.

## Multi-machine and rollback

Anomaly episodes and triage sessions are machine-local observations. Pool
reads inform cooldown but a failed peer read leaves local evidence in control.
The first-wave rollout is dev gated, so a fleet update can install the scripts
without changing its job execution. An operator can set
`jobs.scriptRunners.enabled: false` or add a slug to
`jobs.scriptRunners.disabledSlugs`; the next trigger of an existing converted
job uses its session body. The newly added `script-job-supervisor` skips and its
pass endpoint returns 503 while its runner is inactive, so the fleet gains no
new daily session. `/jobs` reports its runner as `inactive`, and the Jobs detail
card shows `Inactive` in that state.
`jobs.scriptTriage.enabled: false` stops Jev, backup and triage sessions
without disabling script verdicts or anomaly alerts.

## Independent review and evidence

A GPT-6 Astra review found that a heal attempt was marked `ran` at spawn, a
notification could delay critical triage, admission caps could race, a backup
could sample healthy Jev results, and a failed calm-item creation was marked
sent. Those paths were corrected before rollout: a heal now settles at session
end; episode observation and triage start before notification waits; admission
is serialized through counter commit; the backup pool receives only outage
results; and a failed calm-item write is retried. The implementation review
also caught the first-wave default rollout gate and added backup ownership
within the server process. Astra's independent second pass then found that a
backup could start during an already-running Jev recovery request. Both paths
now acquire the same synchronous ownership lane, and a regression test holds
the recovery request unresolved while the backup tick attempts to run.

**Independent second-pass verdict (GPT-6 Astra):** Concur with the review
after the ownership fix. The synchronous acquisition checks backup ownership
and outstanding Jev requests; the server wiring and regression test cover the
recovery-overlap case.

The template wiring review found that the canonical `getDefaultJobs()` entries had
changed but the shipped `health-check.md` was still an agentmd template and
`script-job-supervisor.md` did not exist. Both templates now carry the runner
fields; a shipped-template test checks their manifest and body. Their
`mcpAccess: none` restriction is preserved for rollback sessions.

The full-suite pass also exposed wiring boundaries that focused tests missed.
Audit and supervision logs now use the top-level project directory, which is
present even in production-shaped configs without a `sessions` block. The
outage backup has its own registered LLM attribution and a parsed-output
contract, with provenance enrollment explicitly tracked as pending. Job-body
text reaching the anomaly narrator is classified as
untrusted file content. The unrelated shared script protocol is excluded with
a reason from the Stage-B delivery fingerprint; the certified hashes and
signed delivery evidence remain unchanged.

The self-action convergence pass models one persistent anomaly episode and a
continuing Jev outage. A durable spawned episode settles after one triage
session, including after reconstruction. Outage backup passes are separated by
the durable six-hour stamp. Fresh job results remain separately bounded by
the triage machine and slug daily caps. The registry ratchet drives both
models under sustained pressure and restart schedules.

## Class-Closure Declaration

- Defect class: `unbounded-self-action`
- Closure: `guard`
- Guard: `tests/unit/self-action-convergence.test.ts` (`ratchet`)
- How caught: the registered models prove that one durable anomaly episode
  settles after one triage spawn across restarts and that outage backup checks
  retain a durable six-hour interval with a bounded sample during a sustained
  Jev outage.

Verification before merge: typecheck, lint, focused unit tests for those
boundaries, the route integration tests, a production-shaped E2E route and
supervision lifecycle, and the shared Local Verify merge queue. The broad
local run passed its unit and integration tiers, then exposed E2E fixture
assumptions: one manifest still expected `agentmd`, source-loaded tests could
not find the bundled release key, and three production-shaped configs omitted
`projectDir`. The template expectation now checks the shipped script, key
lookup accepts the source tree's `dist/keys`, and the triage audit path falls
back to the parent of `stateDir`. Focused reruns and Local Verify check those
repairs without taking another broad local test slot. The 48-hour development-agent
observation and seven-day cost comparison are later graduation evidence, not
claims established by this PR.
