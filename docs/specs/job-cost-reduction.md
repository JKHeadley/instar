---
title: Job cost reduction — script jobs run without a model; judgment moves server-side
slug: job-cost-reduction
status: draft
owner: echo
author: echo
parent-principle: "Structure beats Willpower"
requested-by: justin (Telegram topic 130742, 2026-10-26; supervision decision 19:04 PDT, backup clarification 19:06 PDT)
eli16-overview: docs/specs/job-cost-reduction.eli16.md
related:
  - docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md
  - docs/specs/jev-luna-referee-cascade.eli16.md
  - docs/specs/provider-fallback-default-policy.md
  - docs/specs/benchmark-divergence-detector.md
  - docs/LLM-SUPERVISED-EXECUTION.md
  - docs/specs/jev-job-supervision.md
prior-review-convergence: "2026-10-27T02:37:40.367Z"
prior-review-report: "docs/specs/reports/job-cost-reduction-convergence.md"
revision-note: "Jev-first result coverage corrected 2026-10-27; prior approval does not cover this revision"
single-run-completable: true
frontloaded-decisions: 19
cheap-to-change-tags: 1
contested-then-cleared: 3
---

# Job cost reduction

**Revision in progress (2026-10-26):** The operator's 19:06 clarification
requires Haiku/Luna to replace Jev only when Jev is unavailable. The spec text
and triage code now use that rule; production wiring and a fresh convergence
review remain. The older convergence stamp above does not certify this revision.

## 1. Problem (measured)

Measured on the Mac Studio for the week ending 2026-10-26, from Echo's transcripts:

- Echo ran **~3,140 scheduled-job sessions in 7 days**, ~2.4 model calls each.
- Each session loads **~240k weighted tokens** of context before doing anything
  (CLAUDE.md + session-start hook output). The week cost **~756M weighted
  tokens** (756M / 3,140 ≈ 241k per run).
- Almost all of it came from five high-frequency jobs whose whole body is "run
  this one fixed command, record the outcome":

| Job | Cron | Runs/week (nominal) | What the model actually does |
|---|---|---|---|
| health-check | `*/5` | 2,016 | `curl /health`, `df -h`, relay any `degradationSummary` strings, stay silent if fine |
| feedback-factory-triage | `*/15` | 672 | runs one fixed python block verbatim |
| feedback-factory-process | `*/30` | 336 | runs one fixed python block verbatim |
| feedback-factory-execute | `17,47` | 336 | runs one fixed python block verbatim |
| llm-decision-grading | `0 *` | 168 | one `curl POST`, check three field types |

The nominal total is 3,528 runs a week. The measured 3,140 is lower because
gates and quota skips drop some fires. Bob, Cora, AI Guy, Luna and Monroe show
the same pattern, because the cost comes from the shipped templates, not from
Echo's own config.

The waste is structural. Three of these templates say in their own body "Run the
command below ONCE, exactly as written … Do not rewrite it". So a 240k-token
session is being spawned to copy a script into a Bash tool call. The model adds
nothing, and when it improvises it breaks things: one template records an
incident where an improvised zsh loop recorded a failure as a success.

**A gap in the measurement.** commitment-detection (`*/5`, enabled by default) is
not among the measured five. Its gate is only `/health`, so on paper it fires
~2,016 times a week. The §1 measurement did not count it separately, and per-job
attribution does not exist yet (§9 adds it). Its cost is **unmeasured**, so §10
leaves it out of the savings estimate rather than guessing.

## 2. Goals and non-goals

Goals (operator direction):

- **G1.** These jobs become far more efficient. A job whose work is a fixed
  command runs **with no session at all**, and **with no model call on a bare
  healthy run**. A model is called only to classify a non-trivial result (Jev,
  §5.6.2), to word a push (§5.4), or on the outage backup and daily
  reviews; a session starts only when triage says one is needed.
- **G2.** Work that genuinely needs a model runs on the **cheapest capable
  model**, chosen from **Instar benchmark evidence** (e.g. Codex GPT-6 Luna),
  with Claude as the fallback.
- **G3.** Use **Jev (TypeSafe)** wherever the judgment is a classification.
  A confident Jev answer decides; uncertainty starts a bounded investigator.
  Haiku or Luna replaces Jev only during an outage. In v1 that judgment is the
  per-run question "does this result need a real session?" (§5.6.2), with a
  slower Haiku-or-Luna replacement only while Jev is unavailable and one daily
  review (operator decision and clarification, topic 130742, 2026-10-26 19:04–19:06).
- **G4.** **Single-provider floor.** An agent with only one provider, no Jev key
  and no benchmark mirror stays fully functional. Jev, Codex and benchmark
  routing are optimizations, never dependencies. The single-provider path is the
  one measured first.
- **G5.** Migration Parity: existing agents receive all of this on update.
- **G6.** Savings are **measured** per job, before and after, not asserted.

Non-goals:
- Changing what any job decides or reports: its endpoints, outcome rules, silence
  policy, or which machine runs it. The exceptions, each user-visible (F6):
  health-check's notification policy (§5.4: critical problems push at once,
  others after 6 hours and one investigation), commitment-checkin-reminder's
  same-run push for undelivered reminders, and one new high-priority item per
  machine when must-fail canaries fail. Triage calm items are low priority and
  held out of the operator's topic.
- Changing cron cadences. They stay as they are, so before and after numbers
  compare like with like.
- Changing how interactive sessions pick a model.

## 3. Inventory of shipped job templates

Source of truth: `getDefaultJobs()` in `src/commands/init.ts`.
`scripts/regen-default-job-templates.mjs` renders it into
`src/scaffold/templates/jobs/instar/*.md`, which holds 37 templates at
`origin/main` 7376810e2. The `.md` files are generated output, so every change
in this spec is made in `getDefaultJobs()` and `frontmatterFor()`, then
regenerated.

Classes:
- **script**: the body is a fixed command, or a thin trigger to a server endpoint
  that owns every decision, plus a mechanical check of the result. Target: a
  script job with zero LLM calls on the healthy path.
- **judgment**: needs one bounded classification or short-text decision over
  bounded input. Target: the decision moves into a **server-side pass** that
  makes one bounded call (Jev cascade or the default framework). The job becomes
  a script that triggers that pass.
- **agent**: needs multi-step tool use, interpretation, or prose. It stays a
  session in v1; routing it by benchmark evidence is §7 (phase 2).

"Runs/wk" is the nominal count from the cron expression. "On" is the shipped
`enabled` default.

| Template | Cron | Runs/wk | On | Model | Class | Converted in v1 |
|---|---|---|---|---|---|---|
| health-check | */5 | 2016 | yes | haiku | script | **yes** |
| commitment-detection | */5 | 2016 | yes | haiku | judgment | no: phase 2 (§6) |
| commitment-checkin-reminder | */5 | 2016 | no | — | script | yes |
| feedback-factory-triage | */15 | 672 | yes | haiku | script | **yes** |
| mentor-onboarding | */15 | 672 | no | haiku | script | yes |
| feedback-factory-process | */30 | 336 | yes | haiku | script | **yes** |
| feedback-factory-execute | 17,47 | 336 | yes | haiku | script | **yes** |
| llm-decision-grading | hourly | 168 | yes | haiku | script | **yes** |
| evolution-overdue-check | 0 */4 | 42 | yes | haiku | agent | no: the body asks the model to complete, cancel or escalate each overdue item |
| reflection-trigger | 0 */4 | 42 | yes | opus | agent | no |
| evolution-proposal-evaluate | 0 */6 | 28 | yes | sonnet | agent | no |
| overseer-guardian | 0 */6 | 28 | yes | sonnet | agent | no |
| jev-completion-audit | 0 */6 | 28 | no | haiku | script | yes |
| release-readiness-check | 0 */6 | 28 | no | haiku | script | yes |
| evolution-proposal-implement | 1,7,13,19 | 28 | yes | opus | agent | no |
| insight-harvest | 0 */8 | 21 | yes | opus | agent | no |
| identity-review | daily 3 | 7 | yes | opus | agent | no |
| overseer-maintenance | daily 2 | 7 | yes | sonnet | agent | no |
| overseer-infrastructure | daily 6 | 7 | yes | haiku | agent | no |
| overseer-development | daily 8 | 7 | yes | haiku | agent | no |
| feedback-factory-action-list | daily 8 | 7 | yes | haiku | script | **yes**: the server writes and sends the message |
| relationship-maintenance | daily 9 | 7 | yes | haiku | judgment | no (low volume) |
| rope-health-digest | daily 9 | 7 | yes | haiku | agent | no: it delivers text it writes to a digest topic |
| correction-class-review-backstop | daily 8:17 | 7 | yes | haiku | script | **yes** |
| review-canary-battery | daily 6:15 | 7 | no | haiku | script | yes |
| benchmark-divergence-analysis | daily 3:45 | 7 | no | — | script | yes |
| overseer-learning | 3 */2 | ~3.5 | yes | sonnet | agent | no |
| initiative-digest-review | Mon,Thu | 2 | yes | sonnet | agent | no |
| correction-analyzer | Wed | 1 | no | haiku | judgment | no |
| failure-analyzer | Wed | 1 | no | haiku | judgment | no |
| docs-coverage-audit | Mon | 1 | no | haiku | agent | no |
| org-intent-drift-audit | Mon | 1 | no | haiku | judgment | no |
| doorway-scan | Mon | 1 | no | haiku | script | yes |
| routing-price-refresh | Mon | 1 | no | haiku | script | yes |
| stall-matrix-live-check | Mon | 1 | no | haiku | script | yes |
| routing-price-web-verify | Tue | 1 | no | haiku | script | yes |
| bench-refresh | monthly | ~0.25 | no | haiku | agent | no: it compares results against the routing registry and writes attention text |

Counts:
- **17 script**: all converted in v1.
- **5 judgment**: none converted in v1 (§6, §7).
- **15 agent**: unchanged in v1.

## 4. Design overview

1. **Script runner (§5).** A new frontmatter key, `runner: script`, makes a
   manifest with `execute.type: 'script'` that points at a shipped node file. The
   scheduler runs that file with no shell, under the job's normal machine claim,
   with a guard against overlapping runs of the same job and a small cap on how
   many scripts run at once.
2. **Status line, then push (§5.3–5.4).** Each template declares the reasons
   its script may report, each classed as recoverable or critical.
   - A critical reason is pushed straight away.
   - A recoverable reason gets a calm attention item on first sight, within the
     registry's 300-second ceiling. It pushes only in two cases, each sent once:
     the problem is still present after 6 hours, or it keeps recurring (3 times
     in 6 hours). Both messages state only what was observed.
   - The narrator writes a one-paragraph summary. The evidence is rendered
     deterministically, and a fixed sentence is the fallback.
3. **Supervision (§5.6).** Each script job is classed `triage` or
   `deterministic`. A `triage` job's non-trivial results go to Jev, which decides
   "routine" or "needs a real session". An uncertain Jev answer requests a
   bounded investigator session. The script's deterministic rule still applies
   when Jev is unavailable. Only during a Jev outage, a Haiku-or-Luna replacement
   samples routine results at most every 6 hours.
   Daily must-fail canaries prove every script can still fail, and one daily
   review looks across all of it.
4. **Measurement first (§9):** per-job attribution, a frozen baseline, and a
   before/after report.
5. **Phase 2 (§7), a separate spec:**
   - benchmark routing and lean context for the remaining agent-class jobs;
   - Jev-first, event-driven commitment detection (the per-run Jev triage of
     script results is in v1, §5.6.2).

## 5. Script jobs

### 5.1 Template and loader

- **Template keys.**
  - `getDefaultJobs()` entries gain `runner: 'script'`, `script: '<slug>.mjs'`
    and, where needed, `anomalies: [<kind>, …]` (§5.3).
  - `frontmatterFor()` emits these keys.
  - `ALLOWED_FRONTMATTER_KEYS` adds `runner`, `script`, `anomalies`,
    `scriptTimeoutMinutes`, `scriptSupervision`, `triageEvidence`, `triageFields`, and the
    bare-ok / bare-skipped lists (`triageBareOk`, `triageBareSkipped`).
- **Where scripts live and how they ship.**
  - Scripts live in `src/scaffold/templates/jobs/instar/scripts/<slug>.mjs`. They
    are node ESM and use built-in modules only, so they run on macOS and Linux.
  - `src/scaffold` is already in the package `files` list (package.json:111).
  - `installBuiltinJobs()` copies `scripts/*.mjs` to
    `.instar/jobs/instar/scripts/`, always overwriting, under the same contract as
    the bodies.
  - The installer writes `execute: { type: 'script', value: '<slug>.mjs' }`. That
    value is a bare filename validated against `^[a-z0-9-]+\.mjs$`, never a
    command line.
- **Loader branch.** Today `AgentMdJobLoader` loads the body and frontmatter, and
  applies lock-file trust, only for `agentmd` (l.353, l.1266). A new branch does
  the same for manifests that are `origin: instar` with `execute.type: 'script'`:
  - It loads the `.md` body and frontmatter and applies `applyLockFileTrust`.
  - The body stays a **complete, runnable agent prompt**, unchanged in meaning.
    It serves as the narrator's context and as the rollback path (§8.4).
- **Lock file.** `sign-instar-lockfile.mjs` adds a `scriptHash` to every entry
  that has a script. A script job counts as trusted only when both the body hash
  and the script hash match.
- **What happens at run time for each trust verdict:**
  - `trusted`: the script runs.
  - `untrusted-no-lockfile` (unsigned dev builds): the script runs. This matches
    today, where an unsigned agentmd default runs with no allowlist
    (`instar-no-allowlist`). Run history records `lockTrust`.
  - `untrusted-bad-signature`, `untrusted-not-in-lockfile`, or a script-hash
    mismatch: the script is **not run**, and **no session is started**. Starting
    one would mean a read-only session that cannot do the work, at session cost.
    The run is recorded as `failed` (reason `script-untrusted`), so the existing
    consecutive-failure alert fires. One degradation report names it plainly,
    for example: "health check not running: its script failed verification".
  - The script hash is re-checked **immediately before every execution**, not
    only at load, so a file changed after loading never runs.
- **How a script is executed.**
  - The scheduler rebuilds the absolute path from the slug
    (`<stateDir>/jobs/instar/scripts/<slug>.mjs`) and runs it with
    `execFile(process.execPath, [absPath, ...schedulerArgs])`: no shell. The
    working directory is `path.dirname(stateDir)` (the agent root), as today. The
    string stored in the manifest is never executed.
  - The environment is a reduced allowlist: `PATH`, `HOME`, `INSTAR_AUTH_TOKEN`,
    `INSTAR_AGENT_ID`, `INSTAR_PORT` (new), `INSTAR_JOB_SLUG`,
    `INSTAR_MESSAGE_KIND=automated` and `INSTAR_SENDER_CLASS=script`. Child
    probers (doorway-scan, stall-matrix, routing-price) inherit the same set. Their
    current templates already read only these variables plus `.instar/config.json`;
    a unit test runs each prober under the reduced environment.
  - Output goes through the existing secret scrubber
    (`src/core/durableSecretScrub.ts`) and is then capped at 64 KB per run. A run that goes over the cap is
    recorded as `failed`, never cut silently.
- **Who may use script runners.** User-origin `execute.type: 'script'` jobs keep
  today's shell behaviour. `runner: script` is accepted only on instar-origin
  templates in v1, so it grants no new user privilege.
- **Ordering in `triggerJob`.** The script branch (today at l.917, before
  `tryClaim` at l.950, so script jobs never take the claim) moves below the
  claim. It stays **above** the session-capacity check, so script jobs are
  governed only by the script cap below. That way health-check still runs, and
  can report `sessions-exhausted`, when every session slot is full. Script jobs then take the same claim/lease as
  session jobs. `perMachineIndependent` still skips the claim.
- **Overlap and concurrency.**
  - A per-slug `scriptInFlight` set skips a trigger (`skipLedger:
    'already-running'`) while that slug's previous script is still running.
  - No more than **3** scripts run at once per server. A fourth trigger is skipped
    with reason `script-cap` and goes through the existing retry path (retried
    one minute later).
  - Each slug gets a fixed start offset of 0–20 s.
  - Converted templates set `scriptTimeoutMinutes` to the script's real bound;
    the script timeout is twice that. `expectedDurationMinutes` keeps its
    original session value, so the rollback session (§8.4) and a triage session
    get today's session limit, not the script's. A unit test pins that a
    rollback spawn uses `expectedDurationMinutes`.

### 5.2 Script protocol

A script prints exactly one result line, and may also print anomaly lines of the
kinds its template declares:

```
JOB_RESULT ok <short summary>
JOB_RESULT skipped <reason>               # e.g. feature dark (503), prober absent
JOB_RESULT failed <reason>                # also exit code ≠ 0
JOB_ANOMALY <kind> <severity 1-3> <evidence ≤ 300 chars>
JOB_FIELD <key> <value>                   # structured evidence, any number
```

`JOB_FIELD` is the structured-evidence transport. A template declares its
allowed keys (`triageFields`, for example `outcome`, `http_status`,
`server_reason`, `processed`, `attempt_id`). The parser accepts a line only when
the key is declared and matches `^[a-z][a-z0-9_]{0,31}$`, and the value matches
`^[A-Za-z0-9_.:/-]{1,64}$` (no spaces, so no prose); at most 16 fields a run.
Any other `JOB_FIELD` line is dropped and counted in the run's
`droppedFields`. A `structured-only` evidence projection (§5.6.2) is exactly:
slug, result, the result reason code (the first token of the reason, same value
rule), anomaly ids and severities without their evidence text, and the accepted
fields. Each feedback-factory script's unit test pins its emitted fields.

A **new parser** in `runScriptJob` (it parses neither line today) maps each result:

| Script output | Recorded as |
|---|---|
| `ok` | `success` |
| `skipped` | a new run result `skipped` (with reason): counted as neither success nor failure (see below) |
| `failed`, a non-zero exit, a missing result line, or over the output cap | `failure` |
| An anomaly of a kind the template did not declare | ignored and logged |

**What `skipped` changes.**
- It is a new value in `JobRunHistory`'s result type (l.57, l.241), and the
  history routes accept it as a filter (routes.ts ~l.17802, l.17828).
- Stats exclude it from both the numerator and the denominator. Today
  `failures = completed.filter(r => r.result !== 'success')` (l.361) would count
  it as a failure; that line changes.
- It leaves `consecutiveFailures` unchanged, neither raising nor resetting it, so
  a job that alternates failing and skipping still alerts.
- It schedules no retry, and the Jev audit does not capture it.
- CrashLoopPauser and TelemetryCollector already match `failure`/`spawn-error`
  explicitly and need no change.

Every failure path that the python ports used to bury under `sys.exit(0)` and
`INSTAR_JOB_FAILURE_FILE` now prints `JOB_RESULT failed` and exits non-zero. (The
script path never set that variable, so those failures were being recorded as
successes.) Outcomes the server manages itself (the feedback jobs'
`SELF_MANAGED` prefixes) stay `ok`/`skipped`, exactly as the server classifies
them.

Where a template body maps a prober's exit code to "silent", the script maps it
to `skipped`. For example, stall-matrix's `ledger-unreachable` (exit 2) is a
non-signal, so it becomes `skipped`. The mapping table for each script is part
of that script's unit test.

**Failures and anomalies never alert twice for the same thing.** A job that
cannot do its work (server unreachable, bad response) reports `failed`, and
failures alert only through the existing `alertOnConsecutiveFailures` path,
unchanged. Anomaly kinds (§5.3) are things the job *observed* while working
normally, and only the narrator handles them. No condition is both a failure and
an anomaly.

Scripts never message anyone and never call the Telegram relay. A job whose
words are written by the server (feedback-factory-action-list,
release-readiness, stall-matrix, doorway-scan) triggers the server or prober that
writes and sends them, as it does today.

### 5.3 Anomaly kinds

Two templates declare anomalies in v1. Every other converted template's body was
read: each either says "exit silently" or leaves signalling to its own server or
prober.

health-check works out a **reason set** on each run. Disk space comes from the
script's own `fs.statfs` call on the volume that holds the agent's state directory (`<stateDir>`) (`/health` has no disk field).
The other reasons come from the authenticated `/health` fields. Each reason is one `JOB_ANOMALY` line with a stable reason id:

| Template | Kind / reason id | Observed when | Class | Owner of the heal |
|---|---|---|---|---|
| health-check | `disk-low` | free space < 10% on the agent volume | recoverable | none in v1 (no new deletion authority is added) |
| health-check | `disk-critical` | free space < 5% | **critical** (writes start failing, so state is lost) | none in v1 |
| health-check | `sessions-exhausted` | the session limit is reached | recoverable | the session reaper and the resume queue |
| health-check | `llm-unreliable` | `llmReliability.status !== "ok"` | recoverable | the provider circuit breakers and the failure swap |
| health-check | `degradation:<feature>` | one entry per degraded **feature**. Authed `/health` gains a `degradationFeatures` list (each event's stable `event.feature` id, beside the existing `degradationSummary` strings). The strings carry per-occurrence values, so they are evidence only, never the key | recoverable | the subsystem that reported it |
| commitment-checkin-reminder | `undelivered-reminders` | the pass reports `gaveUp > 0` | **critical** (the reminder service's retries are already exhausted) | already exhausted |

**What is deliberately not a reason.**
- `consecutiveJobFailures ≥ 5`, which today also marks the server degraded. Each
  failing job already alerts through `alertOnConsecutiveFailures`, so
  health-check does not repeat that condition.
- `/health` being unreachable or returning non-200. The job cannot do its work,
  so the run records `failed` and alerts through the failure path.

So a condition alerts through exactly one of the two paths, never both. A dead
server is still the lifeline's and the fleet watchdog's case, as it is today.

### 5.4 Status line, then push

This section applies **Self-Heal Before Notify** with its own registry backstop:
`standards.selfHealBeforeNotify.recoverableLatencyCeiling`, 300 s in
`ConfigDefaults.ts`, read live, failing closed to 300 s if the key is missing.

Only reasons that risk **lost data or an undelivered user promise** are critical:
`disk-critical` and `undelivered-reminders`. That matches the standard's critical
class (irreversible or data loss).

**Critical reasons** are pushed on the same detection run, with no delay, and the
owner's heal (if any) carries on at the same time. This is the standard's own
rule for the critical class: an irreversible or data-loss condition escalates on
the same detection tick and heals concurrently (notify-and-heal). It is not an
exception to the standard.

**"Pushed" means delivered.** An episode is marked pushed only when the
notification path returns a confirmed delivery: for Telegram, a message id from
the relay. If the send fails, or its outcome is unknown, the episode stays
unpushed and is retried on the next run. It uses the same idempotency key
(`<episode id>:<push kind>`), so the send path's existing duplicate suppression
drops a repeat of an attempt that actually landed. A failed attempt can never
permanently silence an alarm. **Brakes on the retry:** the retry waits a growing
number of runs (1, 2, 4, 8, then at most hourly); after 6 failed attempts for one
episode, one attention item (`job-anomaly-undelivered:<machineId>`, high,
`source: "agent"`) says a push could not be delivered, and retries continue
hourly while the episode is open. Every attempt is audited.

**Critical pushes go out before anything is written to disk.** `disk-critical`
means writes may already be failing. So for a critical reason, the push goes out
first, and only then are the episode and audit records written; a failed write
never blocks the push. When the store cannot be written, repeat pushes are
limited by an in-memory, per-process record of pushed episodes. That record
holds the same one-push-per-episode limit, and each failed write gets one line on
stderr. A server restart while the disk is still full can therefore push once
more. That is accepted, because a duplicate alarm is better than a silent one.

**Honest limit: a disk that is completely full.** The send path writes its own
records first (the Telegram origin record), and holds a message when it cannot.
So once the disk is completely full, no in-server alarm can leave, in the same
way that a dead server cannot report itself. This is why `disk-critical` fires
at **5% free**: the alarm goes out while space remains. Below that, the server's
own failed writes surface through the existing failure paths and the lifeline.
Building a disk-independent alarm path is out of scope.

**Recoverable reasons get a calm attention item first.** On the same run that
first sees one (latency 0, well within the 300 s ceiling), health-check raises
one **calm attention item**:

- It reads "<reason> on <machine>: seen since <time>; owned by <owner, or \"no owner\">". It states only what was observed, never a heal state.
- It carries `priority: low`, `source: "health-check"` and
  `conditionKey: job-anomaly:<machineId>:<reason id>`.
- The attention hub filter keeps automated low-priority items out of the
  operator's topic and logs them to `logs/attention-hub-held.jsonl`. The item
  still shows in the attention store, on the dashboard, and on the episode row in
  `GET /jobs`.
- It is closed with `POST /attention/clear` when the episode closes.

Health-check never claims that an owner's heal has failed. It cannot see heal
state, since `/health` carries none, and a lasting symptom is not proof of
failure. Not every owner escalates on its own either. `llm-unreliable` is a
24-hour error-rate figure that no breaker turns into an attention item, and
`disk-low` has no owner at all. So one bounded rule covers every recoverable
reason:

- **Heal attempt, then persistence notice.** When an episode has been open for
  **6 hours**, a triage session (§5.6.2) is requested for it if none has run for
  that episode, under the same bounds (cooldown, caps, admission). The push goes
  out only after that attempt settles: the session ran and ended, and the
  episode is still open on the next run; or the session could not be admitted,
  with the reason recorded and named in the push. One push, combined with any
  others due on that run. It states only observations: "<reason> on <machine>
  has persisted for 6 hours; an investigation <ran and it is still present |
  could not start: <reason> | ran at <time> (cooldown)>". It never says "the fix
  failed". **Hard deadline:** the push goes out no later than episode opened +
  6 h + the session cap (30 minutes) + one cron interval, whether or not the
  attempt was seen to end (a restart purge or a missed completion), saying
  "investigation outcome unknown". With
  `jobs.scriptTriage.enabled: false` the attempt is recorded at once as
  `refused: triage-disabled` and the push goes out at 6 hours, as it would
  without triage.
- **Once per episode.** The notice is sent once per episode and is never
  repeated.
- **No suppression by another item.** An owner's own attention item never
  suppresses this notice: nothing here can confirm that item reached the
  operator (the hub filter may have held it), and prefix matching cannot prove it
  is the same condition on the same machine. The cost is at most one possible
  duplicate per episode, after 6 hours; a silent miss would be worse.

This is a deliberate change from today. Today's health-check messages the
operator about any issue it sees. The new one pushes critical ones immediately, and
any other condition only after 6 hours of persistence and one investigation
attempt. That applies Self-Heal
Before Notify and Near-Silent Notifications, and it still leaves nothing silent
indefinitely. `disk-low` has no
owner, so it stays a calm item until it becomes `disk-critical`, which pushes at
once. F6 lists this as a user-visible change.

**One message per run, never one per reason.** All the critical pushes from the
same health-check run are combined into **one** message. It has one
narrator summary and one evidence block listing every reason. A burst of
degradation strings is one notification, within the Bounded Notification Surface
rule.

**Episodes** live in a new machine-local store,
`.instar/state/job-anomaly-episodes.json`. It is deliberately not the job state
file, which is cluster-shared and written only by the lease holder
(`WriteDomainRegistry.ts:217`).
- The store is written by one small `JobAnomalyEpisodeStore` module **directly
  and atomically** (temp file, then rename). It never goes through
  `StateManager.guardWrite`. Standbys therefore record and expire their own
  episodes, as the `external-hog-arm` file is written today.
- Its path is **added to git-sync's per-path exclusion list**
  (`FileClassifier.ts` ~l.164–183) as a build item. The `.instar/state/` tree is
  not excluded as a whole, so this entry is needed.
- Its convergence story follows the `attentionStory` shape
  (`WriteDomainRegistry.ts` ~l.248–253): `logical: pool-scope-read-merge`
  (through `GET /jobs?scope=pool`), `onSharedGitSyncedPath: true`, and
  `fileLevel: git-sync-excluded`.
- **Key.** One episode per `<machineId>:<slug>:<reason id>`. Its stored fields
  are first-seen, last-seen, status-line-sent, pushed, and narrated severity.
- **Coverage across runs.** Coverage is rolling. A skipped or failed run is
  neutral: it neither breaks nor advances an episode. A problem present in 3 runs
  out of 4 therefore still reaches its window.
- **Closing.** Only **3 clean runs in a row** close an episode.
- **Expiry.** If this machine has not run the job for 3 cron intervals (for
  example, its claim moved), its open episodes close as `stale: job no longer
  runs here`, and their calm attention items are cleared. The check runs on
  every scheduler tick and again whenever `buildLocalJobs` reads the store, so it
  never waits on a run that will not come.
- **Pool visibility.** Episodes are attached to each job row in `buildLocalJobs`,
  so `GET /jobs?scope=pool` shows them.
- **Re-push.** A reason that is new to an open health-check run gets its own
  episode, so it gets its own calm attention item, and later its own place in that run's
  combined push. Severity rising from `disk-low` to
  `disk-critical` is a new reason, so it pushes at once.

**Brakes (P19).**

| Brake | Value |
|---|---|
| class | per reason, as in the §5.3 table |
| remediation-actions | `[triage-session]`: one bounded investigation session per episode before the 6-hour push (§5.6.2), idempotent per episode id (a session already run for the episode is not repeated). The owners' own heals still run and audit themselves. A session that could not be admitted is recorded and the push names why, so the notice is never gated on a heal that never happened. |
| max-attempts | one calm attention item and one push per episode; re-pushes only for a new reason |
| max-wall-clock | 15 s for the narrator call |
| backoff | none needed: there is no retry loop, and the next observation is the next cron run |
| dedupe-key | `<machineId>:<slug>:<reason id>` |
| breaker (recurrence) | **Recurrence escalation is separate from the critical class.** A recoverable reason that opens 3 episodes inside 6 h gets **one** "keeps recurring" push. This is the only other exception to "recoverable reasons wait 6 h". After it, that reason's recurrence and persistence pushes are muted for 24 h. Calm items and the audit continue. Critical reasons are never muted: each new episode of `disk-critical` or `undelivered-reminders` pushes. |
| max-notification-latency | 0 s to the calm attention item, within the 300 s registry ceiling. Critical reasons push on the same run. |
| audit-location | `logs/job-anomaly.jsonl` (reason ids, classes, transitions; never raw output) |

**What a push contains.** Two parts, assembled deterministically:

1. **A one-paragraph summary from the narrator.** The narrator gets a fixed
   instruction, shipped in code: "Tell the operator, in plain words, what this job
   observed. Do not instruct. Do not speculate about causes you were not given."
   The narrator call has no tools. Its input is the reason ids and classes, plus
   the first 2,000 characters of the job body as context only (never as the
   instruction), cut with a marker. Input is about 4,000 characters in total.
2. **The evidence block, rendered deterministically and never sent through the
   model.** Each reason's evidence and the degradation strings, word for word: up
   to 20 strings of up to 300 characters each. Any overflow is shown as "and N
   more: see the Jobs tab". Nothing the operator must see verbatim depends on the
   model.

**Routing and failure handling.**
- The narrator is component `JobAnomalyNarrator` in `COMPONENT_CATEGORY` as
  `reflector`. It runs off Claude when another framework is active, and on Claude
  otherwise. Any narrator failure takes the fixed-sentence fallback below. (The
  non-gating failure swap, `intelligence.nonGatingFailureSwap`, may also apply,
  but the design does not depend on it.)
- Each call carries `attribution` with `jobSlug`, `machineId` and the episode id.
- **If the narrator fails** (error, timeout, empty reply, open circuit), the
  summary becomes the fixed sentence "<job> on <machine>: <reasons>." The push
  then sends normally, with its evidence block.
- **If the tone gate answers with an advisory** (`422 tone-gate-advisory`), the
  push is re-sent once with the same text, with `toneAdvisoryAck` set to the named rule,
  `toneAdvisoryAckReason` "deterministic evidence block the operator must see
  verbatim", and the returned `toneAdvisoryDecisionRef`, under a freshly issued
  automation grant (the request's metadata changed, so the first grant does not apply). The evidence block is
  degradation strings word for word and routinely carries config keys, paths and
  feature ids, which the advisory rules flag; an advisory is a signal, and this
  records its grade honestly instead of treating it as a stop.
- **If the gate blocks** (`tone-gate-blocked`, including where the advisory
  migration is dark and B-rules are hard blocks, as on the fleet today; the
  credential wall; or `advisoryUnavailable`), the evidence block is dropped.
  - The evidence is put on a private view (`PrivateViewer.create()`; the tunnel
    URL helper is extracted from `routes.ts` into a shared `viewTunnelUrl()`),
    and the fixed sentence plus that view link is sent through the deterministic topic-send path that the cold-start
    lifeline notice uses. It carries just reason ids and the machine nickname.
    With no tunnel, or for a credential-wall block (the evidence held a live
    credential), no link is sent and the sentence ends "details on the Jobs
    tab".
  - No text the gate refused is ever sent around it.
  - A test pushes a degradation string containing a config key and asserts the
    ack path on an advisory and the view-link path on a block.
- **Delivery goes through the automation reply chokepoint, not `sendToTopic`.**
  `JobScheduler.notifyJobComplete` calls `telegram.sendToTopic` directly, which
  runs neither the tone gate nor the credential-exposure guard. A push therefore
  goes through `sendAutomationReply` (built on `postOriginAutomationReply`),
  producer `job-anomaly` (the slug in metadata), author contract `actual-call` naming the model
  that answered (or the fixed-template contract for the fallback sentence),
  injected into the scheduler from `server.ts`. The producer is added to the
  origin certificate inventory. "Pushed" (above) means that call returned a
  confirmed delivery. The destination is the job's existing one and respects
  `telegramNotify`. Spec 2 needs the same injected helper for its passes;
  whichever spec is built first adds it, and the other reuses it.
- **Ordering at 5% free.** The origin record is written before dispatch, so the
  "push before writing" rule above applies to this spec's own episode and audit
  writes, not the send path's. At 5% free that write still succeeds; below it,
  the honest limit above applies.
- **Topic.** The push needs a `topicId`; health-check's on-alert topic is created
  first when missing, as `notifyJobComplete` does today.

### 5.5 Cost on the healthy path

A healthy run costs zero session tokens. A `deterministic`-class run costs zero
model tokens; a non-trivial `triage`-class run costs one Jev call, and a
bare-ok one nothing (§5.6.2). Each pushed
episode costs one narrator call of about 1–2k tokens. Status lines cost nothing;
they are deterministic text. A triage session costs what a job session costs
today, at most 6 a day per machine.

### 5.6 Supervision: per-run Jev triage, an outage replacement, one daily review

**Draft correction from Justin (2026-10-27).** The original text below limited
Jev to five jobs and skipped plain-healthy, skipped, and cached results. It also
sampled results only every six hours during a Jev outage. Those limits do **not**
match Justin's intended first line of defense and are superseded by this
paragraph and the replacement rule below. The older tables, cost estimates,
tests, and frontloaded decisions in this merged spec still describe the prior
design; they are not approval or implementation instructions for the new path.
This correction stays in draft until the detailed design, benchmarks, tests,
and cost estimate have been reconciled and reviewed. The live Jev path remains
off behind the existing audit gate.

**Replacement result rule.** Every completed script run produces one structured
result record, including success, failure, skipped, and script trust rejection.
Jev receives a bounded, scrubbed projection of each *trusted* result and
answers whether a full investigation session is needed. A trust-rejected run
gets an immediate local failure alert and a safe status-only result check;
untrusted script text is never sent to Jev or another model. Plain-healthy and
repeated results are checked too; a cached verdict cannot silently stand in for
a new per-run check. When Jev is unavailable, Haiku or Luna checks each result
in its place, using the same evidence projection and audit record. If that
replacement is also unavailable, the single-provider agent uses its reachable
model; if no model is reachable, deterministic alerts remain live, the result
is marked `unchecked`, and the missing coverage is surfaced. Uncertain or
malformed answers ask for an investigation session under the existing admission
bounds. A fixed critical alert is delivered without waiting for any model.
Every check, fallback, refusal, and later outcome is recorded for benchmark and
bulk accuracy review. A cost cap may limit spending, but cannot turn a result
into an unreported silent skip.

**Prior design detail below is retained as history pending reconciliation.**
Its narrower `triage`/`deterministic` classes, bare-ok exclusions, fingerprint
reuse, six-hour outage sample, and related tests are superseded by the
replacement result rule above.

`docs/LLM-SUPERVISED-EXECUTION.md` puts health checks at Tier 1, to "detect
false-positive healthy reports". Today a Haiku session on every run pays for that
duty. The operator's decision (topic 130742, 2026-10-26 19:04) replaces it:

> "It depends on the nature of the jobs. Ideally we leverage Jev for most
> situations to determine if the results of a check need a real session with real
> intelligence to handle the situation (with haiku or Luna as a backup to Jev,
> which would run more infrequently than the Jev setup to save tokens). Then a
> single high-level daily review would make sense."

At 19:06 the operator clarified that "back up" means Haiku or Luna **replaces
Jev when Jev is unavailable**. A periodic second opinion while Jev is working
does not meet that decision.

So v1 has four layers. Each script job is classed for the layers it needs.

#### 5.6.1 Which jobs get which layers

| Supervision class | What it means | Templates |
|---|---|---|
| `triage` | its non-trivial results go to Jev (§5.6.2); only during a Jev outage does the slower replacement (§5.6.3) sample routine results | health-check, commitment-checkin-reminder, feedback-factory-triage, feedback-factory-process, feedback-factory-execute |
| `deterministic` | the script's verdict is the whole answer: the endpoint it triggers owns every decision and raises its own attention items, the job is itself an instrument, or (mentor-onboarding) its spec forbids anything outside the server reading its subject | mentor-onboarding, llm-decision-grading, correction-class-review-backstop, feedback-factory-action-list, release-readiness-check, jev-completion-audit, review-canary-battery, benchmark-divergence-analysis, doorway-scan, stall-matrix-live-check, routing-price-refresh, routing-price-web-verify, script-job-supervisor |

This class describes whether the script result needs a separate triage model. It
does not certify that the server endpoint itself is model-free: correction-class
backfill can invoke an LLM and remains on its session runner until benchmark
coverage is certified.

The class is a new template key, `scriptSupervision: triage | deterministic`,
emitted by `frontmatterFor()` and added to `ALLOWED_FRONTMATTER_KEYS`. A script
job without it is `deterministic`. The existing `supervision` field keeps its
`tier0|tier1|tier2` type; converted templates carry `supervision: tier0` (F4).
Every class gets layers 3 and 4 below (canaries and the daily review).

Why these five are `triage`: each one's output can carry a situation a fixed rule
cannot read. health-check relays degradation strings in free text. The three
feedback-factory jobs report the server's self-managed outcomes, whose error text
(a 403 from a lapsed authority, a stuck attempt) is prose.
commitment-checkin-reminder reports undelivered reminders. mentor-onboarding is
`deterministic` because the mentor spec's two-hats boundary forbids any session
reading the mentee's internals outside the server. The other `deterministic` jobs
report counters or "the server raised its own item", so a model reading them
would add cost and nothing else.

**Jobs owned by `docs/specs/job-model-routing.md` (spec 2).** Spec 2's nine
"pass" jobs and its two new script conversions (rope-health-digest,
org-intent-drift-audit) run on this spec's script runner. They are all
`scriptSupervision: deterministic` here: spec 2's pass outcomes and attention
items (its §4.3) own their reporting, and spec 2 puts Jev in front of
commitment-detection and two session jobs itself. No job is triaged by this
spec and also Jev-gated by spec 2. The ownership table is in §5.6.6.

#### 5.6.2 Layer 1: per-run triage (Jev, with the cascade, over a deterministic floor)

After a `triage`-class script run is parsed and recorded (§5.2), and after its
claim is released, the scheduler evaluates the **floor** for that run at once (a
pure function of the result, the streak and the anomaly classes) and then queues
the run for a server-side `JobResultTriage` pass. Triage never holds the claim,
an in-flight slot or a script-cap slot.

The anomaly observer records the run and opens its episodes synchronously. It
then starts triage with the episode id captured for that run before awaiting
narration or Telegram delivery. External anomaly effects are serialized, but a
waiting send cannot postpone a critical investigation. A later close and reopen
gets a new episode id; an older delivery cannot mark the new episode pushed.

- A run the floor marks `needs_session` goes into a **pending set** keyed by
  `<slug>:<reason set>` and is never coalesced away: a later healthy run cannot
  replace it. Its session admission outcome (spawned, suppressed, refused) is
  recorded against it.
- Every other run goes into a cascade queue that keeps the latest run per slug.
  One Jev call runs at a time.

**Trust-rejected runs are never triaged.** A run recorded `failed` with reason
`script-untrusted` (§5.1) is excluded from the floor, the cascade, the backup
check and every triage session: its script failed verification, so nothing
built from its template runs. It alerts through the failure path only.

**Which runs are triaged.** A run whose result is `success` with no anomaly lines
and a summary on the template's declared bare-ok list (for example `ok healthy`)
is `routine` by construction and is never sent anywhere; the canaries (§5.6.4),
not a model reading "ok", carry the false-healthy duty. Likewise a `skipped` run
whose reason is on the template's declared bare-skipped list (for example
`feature-dark` for a 503) is routine and not sent. Every other run (a
`failure`, a `skipped`, any anomaly line, any other summary) is triaged. A run
whose triage input has the same fingerprint (sha256 of the clamped, scrubbed
input) as one triaged for the same slug within `sessionCooldownHours` reuses the
**cascade's** answer with no call. The floor and the admission checks are always
recomputed for the run itself, so identical output on a first and a second
failure still gives the second one its session.

**Evidence policy per template.** A `triage` template declares
`triageEvidence: full | structured-only`. The three feedback-factory jobs are
`structured-only`, because their output can carry fleet users' report text: for
them both the Jev input and the triage session's prompt carry only structured
fields, as defined by the `JOB_FIELD` transport (§5.2), never the free-text
tail. health-check and commitment-checkin-reminder are `full`.

This is **one evidence projection per run**, `triageEvidenceFor(run)`, and every
model consumer reads only it: Jev, the triage session prompt, the
backup check (§5.6.3), and the daily review's `recentOutputs` for script jobs
(§5.6.5). The claim is scoped to prompts and model inputs: a triage session
with Read can still open run history itself. A triage session's final output for a `structured-only` slug is shown
to the daily review only as its first line, clamped to 200 characters. Each
consumer has a test pinning that a `structured-only` slug's free text never
reaches it.

**The question.** Does this result need a real session with real intelligence, or
is it routine?

- **The decision is additive: `needs_session = floor OR Jev`.** Jev can add a
  session; it can never remove one the floor requires. A
  miscalibrated Jev can therefore only cost bounded extra sessions, never hide a
  failure.
- **The deterministic floor.** `needs_session` when the run recorded `failure` on
  the second consecutive failure (one transient timeout spends no session), or
  emitted a **critical** anomaly (§5.3). The streak is computed from **this
  machine's own** `job-runs.jsonl` rows for the slug (they carry `machineId`),
  skipping `skipped`, `script-canary` and `origin: triage` rows (a row without
  `machineId` counts as local only on a single-machine agent), never from the
  cluster-shared `JobState`, which only the lease holder writes. On an agent with no Jev
  and no backup provider, the floor alone decides (G4). (Server-managed
  outcomes are already `ok`/`skipped` by §5.2, so they never reach this rule.)
- **Jev (the cascade, `src/core/JevCascade.ts`).**
  - Input ("state"): the slug, the parsed result and reason, the declared anomaly
    lines, and the last 2,000 characters of the output, produced with
    `scrubThenCut` (`JevReviewFlagShadow.ts`): scrub the whole field, then cut,
    and send nothing on a private-key marker (the floor decides). Quoted as
    untrusted data.
  - One `choice` question, criteria worded to stand alone: `routine` ("the job
    did its normal work; anything it reports needs no one to act right now"),
    `needs_session` ("the result shows something wrong that an operator's
    assistant with tools should investigate or fix now"), `cannot_tell`. Asked in
    both criteria orders in one call, as every Jev instrument does.
  - The forward order's `p(needs_session)` is tested against the unsure band
    (`bandFor('needs_session', …)`, default 0.30–0.70). Outside the band, Jev's
    answer stands. Inside the band, on a `cannot_tell` label, or when the two
    orders disagree, the result needs a bounded investigator session. Jev is
    available in these cases but cannot settle the decision; no backup model
    is called.
  - The model is pinned (`jev-1.13.0`); a served model that does not match is
    discarded and the floor decides alone.
- **When Jev is unavailable.** The deterministic floor still runs immediately.
  The slower Haiku/Luna replacement (§5.6.3) samples the routine outcomes at
  most every six hours. It is silent while Jev is working. The replacement uses
  its own `SingleFlightProvider` slot, with a bounded wait and breaker, so an
  abandoned model call cannot cause overlapping replacements. An outage pass
  owns the decision lane until it finishes; per-run checks do not start Jev
  calls concurrently with that pass. The ownership is symmetric: a backup
  pass cannot acquire the lane while any Jev request, including a recovery
  request after an earlier failure, is in flight. Acquisition is synchronous
  in one process before either provider call; the owner releases in `finally`.
- **What `needs_session` does: a triage session.** The scheduler spawns one
  session through a new `spawnJobTriageSession(job, triageRow)` (named apart
  from the existing `SessionManager.spawnTriageSession`, which serves the
  message triage orchestrator):
  - **Its prompt is a fixed investigator prompt shipped in code**, never the job
    body as instruction. It names the job and its description, gives the run's
    structured fields (result, reason, anomaly ids, server reason codes), quotes
    the scrubbed evidence and the job body in an untrusted-data fence as
    reference only, and says: "Find out why this happened and fix what you can.
    Do not re-run this job's trigger or call its endpoint. Do not message the
    operator; your final answer is recorded for them."
  - It is a derived `agentmd` `JobDefinition`: slug tag `triage:<slug>` (so the
    job's own `already-running` guard never skips the job's next runs while it
    lives), a **fixed allowlist** `["Read", "Grep", "Glob", "Bash"]` (never the
    template's `*`), **the agent's default framework and default model** (not
    the template's `model: haiku`: the operator asked for "a real session with
    real intelligence"; spec 2's pins do not apply to it), and no
    `telegramNotify`.
  - **It carries no credentials in its environment, and is still a trusted
    agent.** It is spawned with the existing `omitAuthEnv: true` spawn option
    (the feedback executor's confined sessions use it), which blanks the Bearer,
    origin, bind, GitHub and fencing tokens from its environment, so nothing in
    its context hands it a credential and the relay script cannot send for it.
    This is **not** an isolation boundary: with Read and Bash it can find the
    auth token in `.instar/config.json` and use any route. So it is treated as
    what it is, a trusted agent session with residual authority, and the bounds
    that actually hold are: the investigator prompt; the narrowed tool set; the
    agent's dangerous-command guards; the in-flight, cooldown and caps; and the
    daily review reading every session's output. For comparison, today the same
    job runs a full-tools session holding the token every 5 minutes; a triage
    session has strictly less. An OS-confined investigator is not built in v1.
    `omitAuthEnv` refuses when the agent authenticates Claude with an
    environment token; `admitTriageSpawn()` pre-checks `anthropicApiKey` and
    records `refused: env-token-auth`, which the 6-hour push names.
  - **Build item: `omitAuthEnv` on the rerouted interactive lane.** Today
    `spawnReroutedInteractive` (the subscription-path lane taken under
    `intelligence.subscriptionPath.mode: force|auto`) blanks credentials only
    when `confinement` is set, keeps the GitHub and fencing tokens, skips the
    credential-shaped-variable blanking, and uses its own 45-minute lifetime. It
    is changed to key the token blanking and the credential-variable blanking on
    `omitAuthEnv`, and to honour `maxDurationMinutes`. A test spawns a triage
    session under `subscriptionPath.mode: force` and asserts no
    `INSTAR_AUTH_TOKEN`, `INSTAR_ORIGIN_TOKEN` or GitHub token in its
    environment, and the 30-minute lifetime.
  - **Tools.** On Claude the triage session uses the positive, existing
    confinement form (`CLAUDE_CONFINED_PERMISSION_ARGS` in
    `credentialEnvNames.ts`, as the message triage session and the feedback
    executor do): no `--dangerously-skip-permissions`; `--permission-mode
    dontAsk --tools Read,Grep,Glob,Bash --no-chrome`; and
    `--strict-mcp-config --mcp-config {}`, so none of the agent's MCP servers
    (Threadline, the browser) load. This applies on both the headless and the
    rerouted interactive lane, with an assert that fails the spawn if the mode
    was not applied (as `applyClaudeConfinement` does). Codex has no tool flag;
    on Codex the narrowing does not hold, and the spec claims it only for
    Claude.
  - The in-flight check keys on the run-history tag `triage:<slug>` (the tmux
    name, `triage-<slug>-<id>`, is display only).
  - It is admitted by `admitTriageSpawn()`, which runs the same read-only, quota,
    session-capacity and work-admission checks `triggerJob` runs. A refusal is
    logged with its reason and never queued.
  - It never touches the slug's `JobState`, failure streak or failure-alert
    state. Its run-history row has a new `origin: triage` field, trigger `triage:<runId>`,
    and is excluded from the slug's stats, streak and CrashLoopPauser.
  - Its end is caught by a `triage:` branch in the completion handler ahead of the
    `this.jobs` lookup (a `triage:` tag is not a registered job). When it ends, its final output (scrubbed, 2,000 characters) is attached to
    the triage row and shown in one calm attention item
    (`conditionKey: job-triage:<machineId>:<slug>`, `source: "job-triage"`,
    priority low), and, for health-check, to the open episode. What reaches the
    operator is still decided only by §5.4's rules.
- **Bounds on triage sessions (P19).**

  | Brake | Value |
  |---|---|
  | in flight | at most one triage session per slug per machine. The pending set holds at most one entry per `<slug>:<reason set>`; a duplicate merges into it |
  | per episode | where a health-check episode exists, admission (per-run triage and the 6-hour request alike) is keyed on the episode id: **one** triage session per episode, shared by per-run triage and the 6-hour heal attempt, critical or not. A new reason (for example `disk-low` rising to `disk-critical`) is a new episode and may get its own |
  | cooldown | for runs with no episode (the other triage jobs), one per `<slug>:<reason set>` per 6 h (`jobs.scriptTriage.sessionCooldownHours`). The reason set is the sorted anomaly ids, or `failure:<reason>`. A critical reason bypasses the cooldown once per reason set per day (not the caps). Before spawning, the cooldown is also checked against the pool (`GET /jobs/triage?scope=pool`), so a claim move does not start a second session for the same condition; if that read fails, the local check decides |
  | caps | 6 per machine per day across all slugs (`maxSessionsPerDay`), and 3 per slug per day (`maxSessionsPerSlugPerDay`). Over a cap, one calm item per day (`job-triage-cap:<machineId>`); a floor-required session refused by a cap is also written onto the open episode or failure alert, and into the daily review's input |
  | duration | the job's `expectedDurationMinutes` × 2, at most 30 minutes |
  | audit | `logs/job-triage.jsonl` through `BoundedJsonlAudit` (14 days, size-capped): slug, run id, result, decider (`floor`, `jev`, `fingerprint-reuse`, `backup`), probabilities, decision, action (`spawned`, `suppressed-cooldown`, `suppressed-cap`, `refused:<reason>`). Never output text |

- **Jev daily cap.** `jobs.scriptTriage.jev.maxChecksPerDay`, default 1,500 per
  machine, seeded from the day's audit rows. Over the cap the floor decides. The
  ceiling is about 1.2M input tokens a day per machine at ~800 tokens a call;
  with the bare-ok and fingerprint rules the expected count is a small fraction
  of it. Jev calls are recorded in `featureMetrics` as `job-result-triage`,
  `framework: typesafe-api`.
- **Egress.** With Jev on, the evidence projection of a triaged run (below)
  leaves the machine to TypeSafe: for `full` templates the scrubbed, clamped
  output tail; for `structured-only` templates only structured fields. Even so,
  sending any job data to a third party is a fleet-wide decision, so `jobs.scriptTriage.jev.enabled` is
  **omitted** and rides the development-agent gate: on for development agents
  (the operator's decision covers his own agents), dark on the fleet, where the
  floor and the slower backup check still run during that Jev-unavailable state. Turning Jev triage on for
  the fleet is a later PR that names this egress (F12).

#### 5.6.3 Layer 2: replacement when Jev is unavailable (Luna or Haiku, slower)

While Jev is available, this check makes **no model calls**. If Jev is disabled,
has no key, has exceeded its daily cap, returns a model mismatch, times out, or
fails a call, the check becomes eligible. It then runs at most **every 6 hours**
per machine (`jobs.scriptTriage.backupIntervalHours`), driven by the scheduler
tick. A recovered successful Jev call makes it ineligible again. The deterministic
floor remains active throughout. The daily overall review (§5.6.5) runs on its
own schedule regardless of Jev availability.

- **It reads a replacement sample, and says so.** For each `triage`-class slug
  it takes only runs that needed Jev but received a deterministic routine
  decision while Jev was unavailable. Healthy Jev decisions, cached Jev
  decisions, and bare-ok runs are excluded; they are not candidates for a
  second opinion. It dedupes by output fingerprint, orders them non-ok and
  anomaly-bearing first, then oldest unseen first, and reads at most 12: each
  run's evidence projection (§5.6.2), clamped to 1,000 characters. It records `considered` and
  `unread: N` per slug per pass. health-check makes ~72 runs in 6 hours, so most
  of its identical healthy runs collapse to one fingerprint; distinct ones beyond
  12 are counted as unread, never claimed as reviewed.
- **The call.** One bounded call per slug, on the outage replacement provider
  (Luna with Codex, the default framework at `fast` otherwise): "Do any of these
  results show something wrong that someone with tools should investigate now?
  Answer per run id." The reply is parsed strictly (a JSON object keyed by the
  given run ids, boolean values); anything else is `backup-failed`.
- A run the backup marks `true` gets a triage session under the same bounds. The
  disagreement is logged as `backup-disagrees` with both verdicts. These are
  disagreement samples, not correct answers; they become calibration labels only
  after a person or a later outcome settles them, and they never change the band.
- **Cursor and retry.** The selected run ids are written to the triage state
  before the call. On success the cursor moves past every run considered. On
  failure the same ids are retried next pass. Two failed passes in a row raise one
  calm item (`job-triage-backup:<machineId>`).
- Cost during an outage: at most 5 slugs × 4 passes a day per machine, each
  about 12k input characters. Cost while Jev works: zero.

#### 5.6.4 Layer 3: daily must-fail canaries (deterministic, every script job)

A model reading run summaries cannot *prove* that a check is able to fail: a
working check and a broken one that always reports success can produce identical
summaries. So each script also gets a daily must-fail canary. Each canary proves
that its script's named failure paths still signal failure: the fixtures listed
in its unit test. It does not prove that every real failure is detected.
- **Who starts them.** Only the scheduler. No manifest, config or environment
  variable can switch them on, and no canary state survives the run.
- **The setup.** Once a day, the scheduler starts a loopback stub on an
  ephemeral port. The stub answers with that script's **must-fail fixture**: a
  500, a malformed body, or, for health-check, a degraded `/health`. The scheduler
  then runs the script with `--server-url <stub>`.
- **Isolation, declared per script.**
  - Scripts that wrap a local prober (doorway-scan, stall-matrix-live-check,
    routing-price-*) also get `--prober <path to a stub prober>`. The stub exits
    with each of the real prober's exit codes, so the script's exit-code mapping
    is what gets tested.
  - The real prober never runs in canary mode.
  - health-check gets `--disk-free-override`. The script rejects this flag, like
    `--server-url`, unless the scheduler started it in canary mode, so the flag can
    never hide a real low-disk reading.
  - In canary mode a script refuses to write any file outside a temp directory.
  - All of the script's server calls go to the stub, so no real pass, send or
    model call can happen.
  - Canary runs are **never** queued for triage, so a canary can never start a
    session.
  - Each script's unit test asserts its canary's side-effect list is empty.
- **The URL flag is loopback only.** Only the scheduler passes it. The script
  parses the URL and refuses any whose parsed hostname is not `127.0.0.1` or
  `::1` (so `http://127.0.0.1@evil` is refused). The flag therefore cannot send
  the auth token anywhere else.
- **Assertions.** Every script must print `JOB_RESULT failed`, or its expected
  `JOB_ANOMALY` lines. Then:
  - **health-check:** the scheduler feeds its reason lines into the real episode
    code with an injected clock, under the isolated namespace `canary:<runId>:…`,
    so it can never collide with a real episode. It asserts every transition:
    calm attention item, no push for a recoverable reason, critical push on the
    same run, close after 3 clean runs, stale expiry, the heal-then-push at 6
    hours (§5.4), and the recurrence push followed by its 24-hour mute. It also
    asserts that the narrator was reached, in `audit-only` mode bound to `runId`,
    which writes the push without sending it.
  - **commitment-checkin-reminder:** its fixture exercises
    `undelivered-reminders`.
  - **The triage floor, both sides:** each `triage` script's canary result is fed
    to the floor function in `audit-only` mode with its expected verdict listed in
    its test: `needs_session` for health-check's `disk-critical` override, the
    critical `undelivered-reminders` fixture and a second consecutive failure;
    `routine` for a recoverable-only health-check fixture and a first failure.
    This proves the single-provider path still asks for a session exactly when it
    should.
- **Results.** Each result is recorded in **this machine's own run history**
  (`job-runs.jsonl` already stores `machineId`, `JobRunHistory.ts:63`) as a
  `script-canary` run, and is audited in `logs/job-anomaly.jsonl` with its
  `runId`. Canary runs go through the same just-before-execution hash check as
  normal runs; a mismatch records `script-untrusted` without running. Failed
  canaries raise **one** attention item per machine, never one per job:
  - `priority: high` and `source: "agent"` (the agent's own safety check failed),
    so it reaches the operator;
  - `conditionKey: script-canary:<machineId>`, listing the failing jobs; it is
    refreshed as that list changes and cleared when every canary passes;
  - per-job detail stays in run history and `GET /jobs`.

  This works on every machine, including standbys, because it never writes the
  cluster-shared job state.

#### 5.6.5 Layer 4: one high-level daily review

- **The endpoint.** `POST /jobs/script-supervision/pass`, Bearer auth, triggered
  by the new shipped script job `script-job-supervisor` (daily, `deterministic`).
  The job is claim-gated and runs on one machine when its script runner is active;
  otherwise the job skips and the endpoint returns 503.
- **What it reads.** The pool view of `GET /jobs` (`?scope=pool`), whose script-job
  rows carry a new `recentOutputs` field (the last 3 `outputSummary` values, each
  about 1,000 characters, already scrubbed) and a new `triage` field: the last
  24 h's counts by decider and decision, sessions started, suppressed or refused
  (with floor-required refusals named), backup disagreements and unread counts,
  canary pass/fail, and each triage session's final output.
- **The call.** One bounded call for all script jobs, not one per job: component
  `ScriptJobSupervisor`, category `reflector`, input wrapped as untrusted data,
  clamped to 60,000 characters (rows beyond it are named as "not reviewed
  today"). The question: "Looking across these jobs' last day, is anything off
  that the per-run checks would not catch: a job whose triage keeps asking for
  sessions, one that never does when its output looks worrying, sessions that
  keep failing to fix the same thing, a canary pattern, a machine missing?"
- **What it may do.** It is advisory. Each flag raises one attention item per slug
  and machine (`conditionKey: script-supervision:<machineId>:<slug>`) or one fleet
  item (`script-supervision:fleet`), with `source: "script-job-supervisor"` and
  priority low, so text injected into job output cannot page the operator through
  it. The pass keeps no state: each pass re-judges and clears items that no
  longer apply. It never starts a session and never changes a band.
- **Gaps.** When the pool read returns `pool.failed` peers, the pass records them
  as "not reviewed today" rather than silently skipping them.
- **Single provider.** It runs on the default framework when no other is active.
- **Cost.** One call a day when active, attributed to the slug
  `script-job-supervisor`; zero calls on a fleet agent with the runner dark.

**Delivery proof, honestly scoped.** The canaries stop before the send. The send
goes through the shared job-notification and topic-send path, which every job and
alert uses. The existing delivery instruments prove that path at runtime: the
Telegram origin detector canaries and the DeliveryFailureSentinel. A weekly real
send to the operator would be the only stronger proof. It would be noise, so it
is not added.

**Cost on the healthy path.** A bare-ok run costs nothing. A non-trivial run of a
`triage` job costs one Jev call (none on a fingerprint repeat). Jev uncertainty
or order disagreement asks for a bounded investigator session. A
`deterministic` job costs nothing. The outage backup and the daily review are
small fixed daily costs. Sessions start only on `needs_session`, bounded above.

#### 5.6.6 Which spec owns each job

| Job(s) | Owner | Jev |
|---|---|---|
| the 17 script conversions in §3, plus script-job-supervisor | this spec | per-run triage for the five `triage` jobs only |
| commitment-detection | spec 2 (§6, a pass) | spec 2's per-row Jev cascade; not triaged here |
| rope-health-digest, org-intent-drift-audit | spec 2 (§3, script) | none; `deterministic` here |
| overseer-guardian/-maintenance/-infrastructure/-development/-learning, relationship-maintenance, correction-analyzer, failure-analyzer | spec 2 (§4, passes on this runner) | none; `deterministic` here, the pass outcomes own reporting |
| reflection-trigger, insight-harvest | spec 2 (§7, sessions) | spec 2's "nothing to do" pre-gate |
| evolution-overdue-check, evolution-proposal-evaluate/-implement, identity-review, initiative-digest-review, docs-coverage-audit, bench-refresh | spec 2 (§5, sessions) | none |

## 6. Why v1 does not convert commitment-detection

commitment-detection (`*/5`, enabled by default) is the one high-frequency
judgment-class job. Round-2 review showed that moving it correctly is a design of
its own:

- Telegram message ids are per chat, and the issues group shares the log, so a
  single numeric cursor skips messages.
- `POST /evolution/actions` has no idempotency today.
- Its local bookmark does not follow a lease move.
- The active-active pool means messages land on more than one machine.

It is also **disabled on Echo** (its last run was 2026-09-08), so its cost does
not appear in the measured week. v1 therefore leaves it unchanged, and §9's
baseline measures its fleet cost. It moves to phase 2 (§7), together with the
Jev work.

## 7. Separate model-routing proposal ([PR #2394](https://github.com/JKHeadley/instar/pull/2394))

What remains after v1:

- **The 15 agent-class templates plus commitment-detection.** About 160 + up to
  2,016 nominal runs a week, using the expensive models.
- **The operator's goal G2 (benchmark routing).** v1 meets it only partly: v1's
  narrator, outage backup check and supervisor run off Claude when Codex is
  active, but no benchmark evidence chooses the model yet. G3 (Jev) is met in v1
  for script-job results (§5.6.2); Jev for commitment detection is phase 2.

PR #2394 is the reviewable tracker for the separate model-routing design.
Its implementation must settle these constraints, carried forward from here:

- **commitment detection becomes event-driven at message ingest**, following the
  existing Jev Telegram shadows (JevCorrectionShadow): no cron cursor. It
  classifies with the standing Jev → Luna cascade, falls back to the default
  framework, and uses a new idempotency key `(chatId, messageId)` on evolution
  actions. The job is retired or kept as a counts-only script. How Jev's authority
  is phased in (the standing cascade directive, versus measuring before granting
  authority) is decided there, on graded outcomes, never on agreement alone.
- **Framework pin and routing.**
  - Jobs gain a `framework` pin honoured by `SessionManager`. `framework: auto`
    resolves a route from a fixed table: template → INSTAR-Bench task(s) in
    `src/data/benchmarkPredictions.json` → pass-rate floor. Bench tasks for the
    overseer and synthesis jobs are added first. A job with no row stays on the
    default framework.
  - Routes use subscription doors only, and only frameworks that enforce the job's
    `toolAllowlist`.
  - An open `divergent-worse` finding vetoes a route.
  - Routes are sticky for 24 h per slug.
  - Quota is read from cached pool state.
- **Lean job context.** It may skip context digests, never safety hooks, and the
  CLAUDE.md share is measured first.

## 8. Migration parity

1. **The installer already carries most of the change.**
   `installBuiltinJobs()` runs on every update (`refreshHooksAndSettings`). It
   always overwrites `.instar/jobs/instar/<slug>.md` and regenerates each per-slug
   manifest, keeping `enabled` and `disabledAtBodyHash`. With §5.1's installer
   change (copy `scripts/`, emit the script manifest), every updated agent moves to
   script runners with no per-agent action.
2. **Config.** Defaults live in code (`ConfigDefaults.ts`, add-missing per key,
   never a whole-block write), so a later default change reaches agents that
   never set the key:
   - `jobs.scriptRunners.disabledSlugs` initially contains every converted
     slug except `llm-decision-grading`; `script-job-supervisor` is installed but
     stays inactive until its LLM call has benchmark and decision-quality audit
     coverage. A later wave removes entries through
     an idempotent migration after its 48-hour review. `jobs.scriptRunners.enabled` is
     **omitted** and rides the development-agent gate: script runners are live on
     development agents and, on the fleet, every pre-existing converted job runs
     its body as a session exactly as today. The new script-job-supervisor skips
     when its script runner is inactive, so a fleet update adds no daily session
     or model call. Taking script runners to the fleet is a later PR
     that changes the code default (F6).
   - `jobs.scriptTriage: { enabled: true, sessionCooldownHours: 6,
     maxSessionsPerDay: 6, maxSessionsPerSlugPerDay: 3, backupIntervalHours: 6,
     jev: { model: 'jev-1.13.0', timeoutMs: 1500, maxChecksPerDay: 1500 } }`.
     `jobs.scriptTriage.jev.enabled` is **omitted** (development-agent gate;
     §5.6.2 Egress). A code-owned audit-readiness gate currently forces effective
     triage off even on development agents and with saved opt-in. The same gate
     keeps later script conversions on their session path, uses deterministic
     anomaly narration, and leaves the daily supervisor inactive. Each model
     family opens only after its calls have benchmark tasks, versioned prompts,
     provenance and outcome grading, and a bulk review path. Config cannot
     bypass this gate. With `jobs.scriptTriage.enabled: false`, no Jev call,
     outage backup check or triage session happens; script verdicts,
     alerts, canaries and the daily review are unchanged.
   - All are read live.
3. **User forks are reported, never rewritten.** Seamless Migration invariant 4
   says the installer never touches `.instar/jobs/user/`, and this spec keeps
   that. A user job whose slug matches a converted default is listed once in
   `logs/job-runner-migration.jsonl` and flagged in `GET /jobs`
   (`shadowsConvertedDefault: true`), so the operator can choose to drop the fork.
   No hash history is needed.
4. **Rollback switch.** `jobs.scriptRunners.enabled: false` (or the gate
   resolving off), or a slug listed in `disabledSlugs`, is read live at trigger
   time. With it set, the scheduler runs a pre-existing converted script job's
   body as an agentmd session: today's behaviour, with no file changed. The new
   `script-job-supervisor` instead skips, including queued dispatch, and its
   pass endpoint answers 503 while inactive. That session is built by
   the same projection as a triage session (a derived `agentmd` definition whose
   prompt is the body), but with the template's own frontmatter allowlist and
   lock trust, never the `legacy` full-tools path that `resolveAllowlist` gives
   a `script`-typed definition. A unit test pins that the rollback spawn resolves
   to the frontmatter allowlist. The rollback holds together because:
   - the body is still the full runnable prompt (§5.1);
   - no user file was rewritten.
5. **Loader compatibility.** The closed set of allowed frontmatter keys is checked
   wherever a body is loaded. Templates and loader ship in the same package
   version, and a test pins that every shipped template loads under the same
   version's loader with no entry skipped.
6. **Agent Awareness.** `generateClaudeMd()` and `migrateClaudeMd()` (guarded by a
   content check) add a short section saying:
   - most scheduled jobs now run as scripts with no session;
   - health-check pushes critical problems at once;
   - other problems show as calm attention items, and send one message only if
     they persist 6 hours or keep recurring;
   - `triage` jobs ask Jev (Luna when unsure) whether a result needs a real
     session, and start one only then, bounded; during a Jev outage a replacement
     samples routine results at most every 6 hours, and one daily review looks across all jobs;
   - where to look: `GET /jobs` (per run: `runner`, `lockTrust`, `tokens`,
     `triage`), `GET /jobs/triage` (recent triage decisions) and `GET /jobs/cost`.
7. **Dashboard.** The Jobs tab shows each job's runner, its last result, its
   7-day token use against the baseline, and its last day's triage decisions and
   triage sessions.

## 9. Measurement

1. **Per-job attribution.**
   - TokenLedger's `token_events` rows are keyed by the Claude transcript
     `session_id`. A side table, `job_sessions(session_id, job_slug, machine_id,
     started_at)`, is written when a job session starts and joined when the
     ledger is read. It is pruned on the same schedule as `token_events`.
   - Model calls made by the narrator, the outage backup check and
     the supervision pass, and Jev calls (`framework: typesafe-api`), are attributed
     through `featureMetrics`. Each carries `attribution.component` plus the
     originating `jobSlug`, `machineId` and episode/run id, so per-slug totals
     are exact.
   - Script runs record `tokens: 0` in run history, so zero is a measured value
     rather than a missing one. A triage session is a job session and is
     attributed through `job_sessions` with `origin: triage`.
2. **Baseline.**
   - Before any template flips, a 7-day baseline is frozen per job and per
     machine.
   - **How it is collected:** the `job_sessions` attribution ships first (rollout
     step 1) and runs for **7 days of prospective collection** before any
     conversion. A best-effort backfill from transcripts sits alongside it. That
     is the §1 scan, which matches a session's first prompt against each job
     body.
   - Sessions the backfill cannot map are reported as an explicit `unmapped`
     count, never dropped.
   - The frozen baseline uses the prospective week. The backfill is shown only
     for comparison.
   - It uses the same scan and weighting as §1, with the weights written into
     the file.
   - It is stored at `.instar/state/job-cost-baseline.json`, together with the
     method and the date range.
   - It counts commitment-detection separately, which closes the §1 gap and
     sizes phase 2.
3. **Read surface.**
   - `GET /jobs/cost?sinceDays=7` returns, per slug: runs, model calls, tokens
     (in, out, cached), weighted tokens, the framework/model mix, narrations,
     and the baseline.
   - `?scope=pool` merges all machines.
   - With no baseline, it answers `baseline: null` and gives the reason.
4. **Rollout report.** Seven days after a slug flips on a machine, a one-time
   report goes to the job log and the existing Updates topic. It:
   - states before and after for that slug;
   - flags for a human look (never as a verdict) any job whose failure or anomaly
     count moved by more than 2× the baseline's daily standard deviation;
   - quotes one raw run end-to-end.
5. **Whether health-check still catches real problems.**
   - **Old reporting as a baseline.** Health-check's old Telegram sends are a
     *behavioural baseline* (what it used to report), not proof of every problem
     that happened. The rollout report compares episodes plus failure alerts
     after the flip against that baseline, for a human to read.
   - **Deterministic proof.** The daily canary (§5.6) proves that detection and
     episode logic still work, with deterministic assertions rather than a model's
     reading.

## 10. Expected savings (an estimate; §9 replaces it with measurements)

**What was measured on Echo:**
- 3,140 job sessions in one week, about 756M weighted tokens, roughly 241k per
  session.
- The operator's analysis found almost all of them came from the five jobs in §1.

Per-job counts were not part of that measurement. So the split below assumes the
remaining agent-class jobs ran close to their nominal ~160 runs; §9 replaces this
with real per-job numbers.

| Part of the week | Sessions (est.) | Weighted tokens (est.) | After v1 |
|---|---|---|---|
| The five jobs | ~2,980 | ~717M | about 12M on average assumptions: Jev calls (billed by TypeSafe, not in this column), bounded narrator, outage backup and daily-review calls, plus at most 6 triage sessions a day per machine (at the historical ~241k average that is ~1.4M weighted tokens a day if the cap is hit; a triage session uses the default model and may cost more, so its real cost is measured separately in §9, `origin: triage`) |
| Remaining agent-class jobs | ~160 | ~39M | unchanged in v1; phase 2's target |
| **Total** | **3,140** | **~756M** | **~40–51M (about a 93–95% cut)** |

**Not in these numbers:**
- feedback-factory-action-list and correction-class-review-backstop (about 14
  sessions a week): their share sits inside the estimates above.
- commitment-detection: it is disabled on Echo and unmeasured on the fleet.
  Phase 2 sizes it from the baseline.

These numbers are **Echo's**. Other agents on the shipped defaults (Bob, Cora,
AI Guy, Luna, Monroe) run the same five jobs, so they should see a similar
absolute saving on them. Their percentage depends on what else they run. In
particular, commitment-detection is enabled by default and adds up to 2,016
nominal sessions a week, which v1 does not touch. Each agent's real numbers come
from §9.

## 11. Rollout

**Audit certification added 2026-10-27 (Justin, topic 130742).** Every new Jev
or LLM call must join the benchmark and decision-quality audit system before
activation. Only `llm-decision-grading` may convert in the first wave: its
grading endpoint is deterministic. `correction-class-review-backstop` remains a
session because its backfill endpoint can invoke `correction-class-review`,
whose benchmark task is still pending. Later conversions, Jev triage, outage replacement, anomaly
narration and the daily supervisor remain code-gated until each call family has
a stable decision-point and prompt identity, actual model and cost/latency
records, scrubbed provenance, outcome grading or an explicit unknown, and a
bulk review report. A pending registry entry or a token counter alone does not
meet this gate. The wider inventory of pre-existing callsites is separate
retrofit work; this rollout does not claim fleet-wide audit completeness.

1. **Measurement.** Land §9.1–9.3. Collect 7 days of prospective per-job
   attribution, then freeze the baselines. No behaviour change.
2. **Runner, no conversions yet.** Land the runner, the loader branch, the lock
   file and the claim-ordering fix. `jobs.scriptRunners.enabled` rides the
   development-agent gate.
3. **First conversion, on development agents.** Convert llm-decision-grading.
   Keep correction-class-review-backstop on its session path until the existing
   `correction-class-review` decision point has benchmark certification.
   - **Pass bar for this step and step 4, over 48 h.** These numbers are inputs to
     a human read of the runs, not an automatic gate:
     - the same number of runs, allowing for cron skips;
     - no run recorded `success` where the server's own log shows that run's
       outcome as a failure;
     - zero session tokens for `deterministic` jobs; for `triage` jobs, sessions
       only where triage asked for one, within the bounds, each one read;
     - the triage log's decider mix (Jev, backup, deterministic) and every
       backup disagreement read;
     - one raw run per slug, read end to end.
4. **The rest, still on development agents.** Convert the three feedback-factory
   jobs, health-check (with the canary passing daily) and action-list. The same
   pass bar applies.
   - The ten converted templates that ship **disabled** are each exercised on a
     development agent with one triggered run against their fixtures. That
     includes commitment-checkin-reminder's `undelivered-reminders` path. They
     stay disabled by default, as today.
5. **Fleet.** Ship a fleet release with every template marked "Converted in v1:
   yes" in §3. Migration Parity (§8) carries it to existing agents.

## 12. Tests (three tiers)

**Unit tests:**
- Each ported script against recorded endpoint fixtures:
  - fixtures: 200, 503 dark, malformed body, timeout, server unreachable, the
    self-managed outcomes, and the prober exit codes;
  - each asserts the exact `JOB_RESULT` line and exit code;
  - an unreachable server must give `failed`.
- Each prober runs under the reduced environment.
- The result-line parser:
  - it maps every result line correctly, including a missing line;
  - it fails a run whose output exceeds the cap;
  - it ignores an anomaly kind the template did not declare.
- The installer:
  - it emits script manifests;
  - it refuses a script name that is not a slug;
  - it copies `scripts/`.
- The loader and runner:
  - the script branch;
  - each trust verdict;
  - re-hashing just before execution;
  - an untrusted script records `failed` and starts no session.
- `skipped` semantics: stats exclusion, failure streak unchanged, no retry, no
  audit capture.
- The lock file's `scriptHash`.
- Overlap and concurrency: single-flight skips, `script-cap` skips with retry,
  and the start offsets.
- The anomaly path:
  - critical reasons push on the same run;
  - recoverable reasons raise a calm attention item, then one push after 6 hours
    of persistence;
  - an owner's open item for the same condition does not suppress that push;
  - a skipped or failed run is neutral for the rolling window;
  - the episode store is written atomically outside `guardWrite`, its path is
    excluded from git-sync, and stale episodes
    expire;
  - job-failure reasons are excluded;
  - the evidence block is rendered verbatim, without going through the model;
  - episode state persists across a restart;
  - severity changes and new strings trigger re-narration;
  - episodes close only after the required clean runs;
  - the recurrence push and its 24-hour mute work, and critical reasons are
    never muted;
  - a failing push retries with growing spacing, and the sixth failure raises
    one undelivered item;
  - the fixed template is sent when the model fails, and when the tone gate
    holds the narration;
  - `boundedTail` leaves its marker.
- Triage (`JobResultTriage`):
  - a confident Jev `routine` is taken; a confident `needs_session` is taken;
  - an answer in the unsure band, `cannot_tell`, or order disagreement requests
    a bounded investigator session;
  - the served-model mismatch, HTTP error, timeout, no key and daily cap each fall
    to the deterministic rule, and the rule gives `needs_session` exactly for a
    second consecutive failure or a critical anomaly (both sides tested: a first
    failure and a recoverable anomaly give `routine`);
  - no second model is called while Jev is available;
  - `deterministic`-class jobs and canary runs are never triaged;
  - `needs_session` starts one session with the investigator prompt and the
    fixed allowlist; in-flight, cooldown and daily cap each suppress, and the cap
    raises one calm item per day;
  - the daily cap and cooldown survive a restart (seeded from state);
  - the state sent to Jev is scrubbed and clamped; the audit row carries no
    output text;
  - `jobs.scriptTriage.enabled: false` makes no call of any kind;
  - the floor is additive: a confident Jev `routine` with a critical anomaly or
    a second consecutive failure still starts a session;
  - bare-ok runs are never sent; a repeated fingerprint reuses its verdict;
  - differing forward/reversed labels request an investigator session under the
    same admission limits; Jev timeout and missing key fall to the floor;
  - the triage session is an `agentmd` projection with the fixed allowlist, the
    investigator prompt and slug tag `triage:<slug>`; it never resolves to
    `legacy`; the job's own next run is not skipped while it lives;
  - a failing script plus its triage session still alerts on schedule; the
    session's row is excluded from stats and streak; JobState is untouched;
  - triage runs after the claim is released and holds no script-cap slot;
  - the floor's streak comes from this machine's run rows (a standby fixture);
  - the triage spawn carries the confinement arguments and loads no MCP server,
    on both lanes;
  - all canaries failing raise one item per machine, not one per job;
  - a persistent critical episode gets one triage session, not one per run after
    each session ends;
  - a `structured-only` slug never sends or quotes free text; undeclared or
    malformed `JOB_FIELD` lines are dropped and counted;
  - an outage backup provider that ignores its timeout keeps its
    `SingleFlightProvider` slot until it settles or is abandoned at 120 s;
  - repeated `script-untrusted` failures alert but never start a triage session;
  - a triage session is spawned with `omitAuthEnv` (no Bearer or origin token in
    its environment) and the fixed allowlist; an env-token agent records
    `refused: env-token-auth`;
  - the push's hard deadline fires with "outcome unknown" when the session's end
    is never seen;
  - the 6-hour push waits for one triage attempt, or names its refusal, and
    with triage disabled records `refused: triage-disabled` and pushes at 6 h;
  - identical output on a first and second failure: the second still gets a
    session (the fingerprint reuses only the cascade answer);
  - a floor-required run is not displaced by a later healthy run in the queue.
- The backup check: runs at most every 6 h only while Jev is unavailable; reads only `routine`
  runs left by an unavailable Jev since its cursor, deduped and prioritised, at most 12, and records
  `unread`; a strict-parse failure is `backup-failed` and the same ids are
  retried; a disagreement starts a bounded session and logs `backup-disagrees`;
  two failures in a row raise one item.
- The canaries:
  - each script fails on its must-fail fixture;
  - the URL flag refuses anything that is not loopback;
  - the health-check episode run reaches each transition under the injected
    clock;
  - canaries cannot be enabled from the manifest, config or environment;
  - they never touch a real episode.

**Integration tests:**
- A script job runs through `runScriptJob` with zero sessions. It takes and
  releases the claim.
- An anomaly produces exactly one narration per episode.
- `POST /jobs/script-supervision/pass`, `GET /jobs/triage` and `GET /jobs/cost`
  work over HTTP.
- A `triage` script job whose result Jev (stubbed endpoint) calls
  `needs_session` starts exactly one session; a second inside the cooldown does
  not.

**E2E tests:**
- The production init path installs the templates, and `GET /jobs/triage`
  answers 200 on it.
- A fresh agent and an updated agent both end up with script manifests and
  `scripts/`.
- health-check fires on schedule with no session.
- The rollback flag restores agentmd behaviour live.
- The package contains `scripts/`.

**Wiring tests:**
- The narrator, the triage pass (Jev client and deterministic floor), the
  backup check, the supervision pass and the job-session attribution are
  non-null.
- They delegate to the real intelligence provider, as wired in `server.ts`.

## Maturation plan

- **test-agent-live:** a throwaway agent on one machine with all 17 templates
  converted. Run each script once on its normal fixture and once on its
  must-fail fixture, and observe the job result, the run history and the zero
  sessions. Fill a temp volume below 5% free and observe one critical push.
- **dev-agent-live:** §11 steps 3 and 4 on the development agents (Echo first),
  each for 48 hours. The flag is `jobs.scriptRunners.enabled`, which rides the
  development-agent gate. The step 3 pass bar applies.
- **fleet:** the converted templates already reach every agent through
  `installBuiltinJobs()` (§8); on the fleet they run their bodies as sessions
  until a later PR changes the `jobs.scriptRunners.enabled` code default. That
  PR ships only after the graduation criterion holds on the development agents.
  Jev triage on the fleet is a separate later PR (F12).
- **graduation criterion:** over 7 days on Echo, each of the following is checked
  in the job-cost report, never inferred:
  - zero session tokens for the converted jobs, apart from triage sessions,
    each of which is listed and read;
  - a single-provider pass: one development agent run for 48 h with the Jev key
    and Codex unavailable, triage falling to the deterministic rule and the
    backup check on Claude;
  - the same run count as the baseline, allowing for cron skips;
  - no run recorded `success` where the server's log shows a failure;
  - all must-fail canaries passing daily;
  - one raw run per slug read end to end.

  A zero count of runs is not a pass.
- **dark-window:** at most 21 days from merge to the fleet decision. If the
  criterion is not met by then, the reason and a new date are recorded on the
  phase-2 tracking commitment. The feature is never left dark silently.

## 13. Multi-machine posture

- **Script job runs**: `unified`. They take the claim/lease like session jobs once
  the §5.1 ordering fix lands.
  - Jobs already marked `perMachineIndependent` keep that marking:
    llm-decision-grading, doorway-scan, jev-completion-audit,
    stall-matrix-live-check, routing-price-refresh, routing-price-web-verify.
  - Each of these reads or writes only its own machine's local data.
- **health-check**: `unified`. It is claim-gated, unchanged from today (the §2
  non-goal), so it checks the disk of the machine holding the claim, and other
  machines' disks are not checked. That is today's behaviour, and it is stated
  here rather than left implied. The narration names the machine's nickname.
- **Supervision pass**: `unified`. It is claim-gated, reads every machine's
  script runs through `GET /jobs?scope=pool` (`recentOutputs` on each row), and
  keeps no state of its own.
- **Per-run triage and its cooldown**: `unified` in effect. Each machine triages
  the runs it executed (the claim already puts each claim-gated run on one
  machine), and the cooldown is checked against the pool view
  (`GET /jobs/triage?scope=pool`) before any session is spawned, so a claim move
  does not start a second session for the same condition. If the pool read
  fails, the local cooldown decides; the residual is at most one extra session
  per condition per claim move, inside the caps.
- **Triage session caps and spawned sessions** (`.instar/state/job-triage-state.json`):
  `machine-local`. The caps bound sessions this host spawns and runs in its own
  process slots, and a triage session runs on the machine whose run it
  investigates. The file is written atomically outside `guardWrite`, only on
  change, excluded from git-sync, registered machine-local in
  `WriteDomainRegistry`, and merged on read by `GET /jobs/triage?scope=pool`.
- machine-local-justification: hardware-bound-resource impossible-because="the-caps-bound-sessions-spawned-into-THIS-host-process-slots-and-the-backup-cursor-points-into-THIS-machine-own-run-history" permanence=permanent
- **Must-fail canaries**: each machine runs them for its own scripts, because a
  canary proves *this machine's* script and scheduler code. Their only state is
  audit rows. They pass or fail through the job result, which is visible through
  the pool view.
- **Anomaly episode store** (`.instar/state/job-anomaly-episodes.json`):
  `machine-local`. An episode describes this machine's disk, sessions and server,
  observed live, so a copy on another machine would describe the wrong hardware. It is registered as
  machine-local in `WriteDomainRegistry`. It is visible through
  `GET /jobs?scope=pool`, and it expires when this machine stops running the job.
- machine-local-justification: hardware-bound-resource impossible-because="an-episode-is-a-live-observation-of-THIS-machine-disk-sessions-and-server" permanence=permanent
- **Job cost baseline and `GET /jobs/cost`**: each machine keeps its own data,
  merged when read with `?scope=pool`.

## 14. Decision points touched

| Decision point | Class | Justification / floor |
|---|---|---|
| Script result → success/failure (`JOB_RESULT`, exit code, prober-exit mapping) | invariant | fixed protocol, unit-tested per script |
| Script emits a declared `JOB_ANOMALY` (§5.3 thresholds) | invariant | fixed numeric thresholds, both sides tested |
| Reason class → push now (critical), or a calm item plus one push after 6 hours of persistence (recoverable); episode open, close, expire, re-push | invariant | fixed table and clock (§5.3–5.4) |
| Narration wording | judgment-candidate | one bounded call; floor: fixed template on model failure or tone-gate hold, sent on the deterministic path |
| Script trust verdict → run, or record `failed` with no session | invariant | lock-file hashes, re-checked immediately before execution |
| Must-fail canary passed or not | invariant | deterministic assertion per script |
| Supervision "anything odd?" (daily review) | judgment-candidate | advisory flag only, no action; floor = no flag |
| Triage: does this script result need a real session? | judgment-candidate | `needs_session = floor OR Jev`. Floor (deterministic, always applied): a second consecutive failure or a critical anomaly ⇒ session. Jev can only add sessions; uncertainty or order disagreement also requests one. Bounded by in-flight, cooldown, per-slug and daily caps |
| Outage replacement: does a routine-classified result need a session? | judgment-candidate | only while Jev is unavailable, one bounded `fast`-tier call per slug per 6 h; floor = no extra session (the per-run verdict stands) |
| Triage session spawn admitted | invariant | in-flight, cooldown, per-slug and daily caps, then `admitTriageSpawn()` (read-only, quota, capacity, work admission) |
| Which runs are triaged (bare-ok skip, fingerprint reuse) | invariant | fixed per-template bare-ok list; sha256 fingerprint |
| Forward/reversed Jev order reconciliation | invariant | forward order tests the band; differing labels request an investigator session |
| Outage replacement provider selection | invariant | Codex when available, else the default framework at `fast`; none ⇒ floor alone |
| Triage session outcome recording | invariant | `origin: triage` row, excluded from the slug's stats, streak and JobState |
| Heal attempt before the 6-hour push | invariant | one triage session per episode, or its recorded refusal, then the push |
| Rollback flag | invariant | operator switch, read live |

## 15. Frontloaded Decisions

- **F1 Script runtime:** node `.mjs`, built-in modules only, run through
  `execFile(process.execPath)` with no shell, cwd set to the agent root.
- **F2 Cadences:** unchanged.
- **F3 Narrator and supervision category:** `reflector`.
- **F4 Tier-1 supervision: a stated deviation, set by the operator.**
  - `docs/LLM-SUPERVISED-EXECUTION.md` defines Tier 1 as per-run LLM validation.
  - Converted script jobs carry `supervision: tier0` plus `scriptSupervision`
    (§5.6.1).
  - Per-run session supervision is replaced, per the operator's decision of
    2026-10-26 19:04, by: deterministic result parsing on every run; for
    `triage` jobs, a per-run Jev triage (uncertainty requests a bounded
    investigator session; the deterministic rule runs when Jev is unavailable);
    a replacement Haiku-or-Luna check at most every 6 hours while Jev is unavailable; deterministic
    must-fail canaries every day; one high-level daily review; and the existing
    consecutive-failure alerts.
  - `docs/LLM-SUPERVISED-EXECUTION.md` makes every scheduled job critical by
    default, and these stay critical: v1 does not declare them otherwise. Their
    Tier-1 supervision is layered rather than per-run: Jev reads every
    non-trivial result while available; bare-ok results are covered
    by the daily review, and their ability to fail
    is proven by the canaries rather than by a model reading "ok".
  - The registry article's `Fails` clause (when the supervisor is unavailable,
    do not run the pipeline "unless a separately ratified deterministic safe rung
    governs it"): the always-applied deterministic floor and the canaries are that
    rung, ratified by the operator's decision of 2026-10-26 19:04. With no Jev
    the job still runs, governed by the floor, and the outage backup check and
    daily review still read it on the default framework.
  - The standard's tier table gains a "script job (layered Tier 1)" line and the
    critical-pipeline section a sentence naming this layering, in the same
    change.
    `docs/LLM-SUPERVISED-EXECUTION.md` is not under CODEOWNERS (only
    `STANDARDS-REGISTRY.md` and `.github/CODEOWNERS` are), so no operator
    approval is needed for it.
- **F5 Scope:** v1 is §5, §8 and §9.
  - Phase 2 is a separate spec covering benchmark routing, lean context, and
    Jev-first commitment detection.
  - Its commitment is registered when this spec is accepted.
  - The partial delivery of G2/G3 in v1 is stated plainly in §7 and in the
    summary to the operator.
- **F6 Fleet default on** after the §11 pass bars.
  - *Cheap to change later*, for the runner itself only: the flag restores
    agentmd behaviour live, and no user file is rewritten.
  - *Not cheap*, and not claimed to be:
    - a user-visible change: health-check now pushes critical problems
      immediately, and others only once they have persisted for 6 hours; until
      then they appear as calm attention items;
    - the new `GET /jobs` fields, `GET /jobs/cost` and the Jobs-tab surfaces;
    - narrations already sent.
  - These ship only after the §11 development-agent bar.
- **F7 Reasons, classes and windows:** as in the §5.3 and §5.4 tables.
  - A calm attention item is raised on first observation.
  - A recoverable reason gets one push only if it persists for 6 hours, or one
    if it recurs 3 times in 6 hours. Either push is skipped when an owner's own
    open attention item already covers the same condition.
  - Critical reasons are pushed immediately, and are never muted.
- **F8 Concurrency:** 3 scripts per server; a fourth is skipped with reason
  `script-cap` and retried after 1 minute. Each slug gets a fixed start offset of
  0–20 seconds and has one run in flight at a time.
- **F9 Health-check heal authority:** none in v1. Owners heal; health-check only
  observes and reports. A triage session (§5.6.2) has the fixed allowlist
  `Read, Grep, Glob, Bash` (F13) and nothing more.
- **F10 Triage classes:** as in the §5.6.1 table: five `triage`, thirteen
  `deterministic` (mentor-onboarding included, for its two-hats boundary). Not
  cheap to change: moving a job to `triage` turns on third-party egress and
  session-spawning authority, so it needs its own review and a development-agent
  soak.
- **F11 Triage bounds and cadences:** Jev unsure band 0.30–0.70,
  1,500 Jev checks per machine per day, one triage session per slug and reason set per
  6 h (critical bypasses the cooldown), at most 3 per slug and 6 per machine per
  day, backup check at most every 6 h during a Jev outage over at most 12 distinct runs per slug. All are
  `jobs.scriptTriage.*` config, read live.
- **F12 Jev egress:** `jobs.scriptTriage.jev.enabled` rides the
  development-agent gate. Fleet egress of job output to TypeSafe is a later PR
  that states it in the Agent Awareness text and the release notes.
- **F13 Triage sessions:** a fixed investigator prompt shipped in code (the job
  body is reference only), the fixed allowlist `Read, Grep, Glob, Bash`, slug tag
  `triage:<slug>`, spawned with `omitAuthEnv` (no credentials), no
  `telegramNotify`, an `origin: triage` run row outside the slug's stats.
- **F14 Outage replacement provider:** Codex (`fast` = GPT-6 Luna) when
  available, else the default framework at `fast` (Haiku on Claude); its own
  breaker. It is called only while Jev is unavailable.
- **F15 Jev order reconciliation:** the forward order tests the band; if the two
  orders' labels differ, a bounded investigator session is requested.
- **F16 Triage session model:** the agent's default framework and model, not
  the template's tier. Worst case 6 sessions a day per machine, as §10 counts.
- **F17 Evidence policy:** the feedback-factory jobs are `triageEvidence:
  structured-only`; the others `full`.
- **F18 Send helper:** pushes use the injected `sendAutomationReply`; the first
  of this spec and spec 2 to be built adds it.
- **F19 Advisory holds:** an advisory is acknowledged with a fixed reason and
  re-sent once; a block drops the evidence to a private view link.

## 16. Open questions

*(none)*
