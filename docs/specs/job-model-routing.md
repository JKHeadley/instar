---
title: Job model routing — evidence-chosen models for the jobs that still need one, Jev first
slug: job-model-routing
status: draft
owner: echo
author: echo
requested-by: justin (Telegram topic 130742, 2026-10-26)
eli16-overview: docs/specs/job-model-routing.eli16.md
depends-on: docs/specs/job-cost-reduction.md
related:
  - docs/specs/job-cost-reduction.md
  - docs/LLM-ROUTING-REGISTRY.md
  - docs/specs/per-component-framework-routing.md
  - docs/specs/benchmark-divergence-detector.md
  - docs/specs/llm-decision-quality-meter.md
  - docs/specs/jev-correction-live.md
  - docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md
review-convergence: "2026-10-27T02:13:46.694Z"
review-iterations: 6
review-completed-at: "2026-10-27T02:13:46.694Z"
review-report: "docs/specs/reports/job-model-routing-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 26
cheap-to-change-tags: 0
contested-then-cleared: 4
---

# Job model routing

## 1. Problem

`docs/specs/job-cost-reduction.md` (spec 1, PR #2391) turns 17 built-in jobs into
model-free scripts. It deliberately leaves two of the operator's asks to this
spec (its §7):

- **G2.** Jobs that genuinely need a model run on the best-value model the agent
  can reach, chosen from Instar benchmark evidence (for example Codex GPT-6
  Luna), with Claude as the fallback.
- **G3.** Use Jev (TypeSafe) as much as possible, through the standing cascade:
  Jev's answer when it is confident, GPT-6 Luna when Jev is unsure
  (`src/core/JevCascade.ts`).

Both are bounded by **G4, the single-provider floor**: an agent with one provider,
no Jev key and no benchmark mirror stays fully functional. Jev, Codex and
benchmark routing are optimizations only, and the one-provider path is measured
first.

**Hard dependency.** This spec builds on spec 1's script runner (`runner:
script`), its `job_sessions` attribution, `GET /jobs/cost` and its frozen
baseline. None of those exist on `main` yet. This branch is stacked on spec 1's
branch, and no part of this spec is built before spec 1 merges.

What remains after spec 1 is 20 templates: 15 agent-class jobs and 5
judgment-class jobs, including commitment-detection (`*/5`, on by default, about
2,016 nominal runs a week). Each spawns a full session on the agent's default
framework, loading roughly 240k weighted tokens of context before doing anything
(spec 1 §1).

What exists today (checked at `origin/main` e0ff984b3):

| Piece | State | Used here for |
|---|---|---|
| Job → framework | `JobDefinition` has **no** `framework` field; `JobScheduler` calls `spawnSession` without one. `spawnSession` accepts a per-call `framework` and a raw model id, and falls back honestly (labelled) when a headless lane is closed. | §5 |
| Per-component routing | `IntelligenceRouter`: off-Claude by default for sentinel / gate / reflector components, failure-swap down the active chain, and a nature-axis resolver (`sessions.natureRouting`, dev-gated, dry-run) over the bench-cited chains in `src/data/llmBenchCoverage.ts`. | §4, §6 |
| Benchmark evidence | `src/data/benchmarkPredictions.json` holds two tasks captured 2026-07-23. The chains name `gpt-5.4-mini` / `gpt-5.5`. **No GPT-6 (Luna / Sol) evidence is in the repo, and no task resembles a job.** | §5.3 |
| Divergence + quality | `BenchmarkDivergenceAnalyzer` compares predictions with graded outcomes from the decision-quality meter; both are dev-gated (dark on the fleet). Grading (`decisionGradingPass.ts`) is deterministic only, each rule with a registered owner. | §5.3 |
| Doorways | `GET /doorways` + `DoorwayRegistryReader`. | §5.2 |
| Jev | Correction, signal, circles, review-flag and memory-picker integrations. Only `JevSignalShadow` uses `JevCascade`, whose referee is hard-wired to the Codex `fast` tier. | §6, §7 |
| Promise detection | commitment-detection, a session every 5 minutes, reads the tail of `telegram-messages.jsonl` past a bookmark and records each commitment, promise or action item as an evolution action with a deadline; evolution-overdue-check follows those up. Separately, `CommitmentSentinel` runs in the server and records commitments the user asked for. | §6 |
| Codex safety hooks | `installCodexHooks.ts` writes instar's gates into the per-project `.codex/hooks.json`; `codexHookTrust.ts` trusts each hook by content hash. The blocking gates run on PreToolUse; the event reporter only on PostToolUse / UserPromptSubmit. Codex has no `--allowedTools`. | §5.2 |
| Codex token accounting | Codex tokens land in `codex_token_sessions`, matched by working directory; a Codex session's rollout id is known only once discovered after spawn. | §11 |
| Job notifications | `JobScheduler.notifyJobComplete` sends with `telegram.sendToTopic` directly. The credential-exposure guard and the tone gate run only in the `/telegram/reply` route. | §4 |

## 2. Goals and non-goals

Goals:

- **G2a.** A job that needs one bounded decision or one short write makes **one
  server-side call** through `IntelligenceRouter` instead of spawning a session.
- **G2b.** A job that genuinely needs a multi-step session can be **pinned to
  another framework and model chosen from benchmark evidence**, and falls back to
  the agent default whenever that route is not usable at run time.
- **G3a.** commitment-detection, the most frequent job, stops spawning a session:
  it becomes a server-side pass with the same question and the same output, and
  Jev sits in front of its model call.
- **G3b.** Jev decides "is there anything here worth a model's time?" before an
  expensive session is spent, where the input is bounded text.
- **G4.** Every path has a named single-provider behaviour, measured first.
- **G5.** Migration parity: existing agents receive all of it on update.
- **G6.** Savings and quality are measured per job, before and after (§11).

Non-goals:

- Changing what any job decides, where it reports, or its cadence.
- Changing how interactive conversation sessions pick a model.
- Model comparisons outside the existing INSTAR-Bench harness.
- Spending money: metered doors are never in a job route.


## 3. The remaining jobs, and what each becomes

Source of truth stays `getDefaultJobs()` in `src/commands/init.ts`, regenerated
into `src/scaffold/templates/jobs/instar/*.md` (spec 1 §3).

Target classes:

- **script**: spec 1's script runner; zero model calls.
- **pass**: a spec-1 script that triggers one server-side pass: deterministic
  gather, one routed bounded call, deterministic delivery through the reply
  checkpoint (§4).
- **session**: stays a session. Four are **pin candidates** (§5): a PR may pin
  them to a benchmark-chosen framework and model. Two get a Jev pre-gate (§7).

| Template | Runs/wk | On | Today | Becomes | Why |
|---|---|---|---|---|---|
| commitment-detection | 2016 | yes | haiku session | **pass**, Jev in front | Same question, record and follow-up as today, with no session (§6). |
| rope-health-digest | 7 | yes | haiku session | **script** | The server composes and scrubs the digest; the job only routes it to a configured topic. Spec 1 misfiled it as agent. |
| org-intent-drift-audit | 1 | no | haiku session | **script** | `GET /intent/org/drift` returns `trend`, `summary`, `suggestions`; the send becomes a fixed template over those fields. |
| overseer-guardian | 28 | yes | sonnet session | **pass** | Reads one category report, writes findings + a handoff. |
| overseer-maintenance | 7 | yes | sonnet session | **pass** | Same shape. |
| overseer-infrastructure | 7 | yes | haiku session | **pass** | Same shape. |
| overseer-development | 7 | yes | haiku session | **pass** | Same shape. |
| overseer-learning | ~3.5 | yes | sonnet session | **pass** | Same shape. |
| relationship-maintenance | 7 | yes | haiku session | **pass** | Bounded read of relationship records; reports notable silences. |
| correction-analyzer | 1 | no | haiku session | **pass** | `POST /corrections/analyze` does the work; the model sanity-checks routed items and writes one message. |
| failure-analyzer | 1 | no | haiku session | **pass** | Same shape over `POST /failures/analyze`. |
| evolution-overdue-check | 42 | yes | haiku session | **session**, pin candidate | Must try to complete or advance actions. Already gated on a non-empty list. |
| reflection-trigger | 42 | yes | opus session | **session**, pin candidate, pre-gate | Writes MEMORY.md; most runs find nothing. |
| evolution-proposal-evaluate | 28 | yes | sonnet session | **session**, pin candidate | Approves or rejects proposals. Already gated. |
| insight-harvest | 21 | yes | opus session | **session**, pin candidate, pre-gate | Creates proposals, marks learnings applied. Already gated. |
| evolution-proposal-implement | 28 | yes | opus session | **session**, default | Writes code; stays on the framework with the full gate set. |
| identity-review | 7 | yes | opus session | **session**, default | Low volume. |
| initiative-digest-review | 2 | yes | sonnet session | **session**, default | Low volume. |
| docs-coverage-audit | 1 | no | haiku session | **session**, default | Low volume, off. |
| bench-refresh | ~0.25 | no | haiku session | **session**, default, never pinned | Runs the bench; choosing its model by the bench is circular. |

Counts: 2 script, 9 pass, 9 session (4 pin candidates).

Nominal weekly sessions removed by script and pass: about 2,016 + 8 + ~62
= **~2,086**. commitment-detection's real run count comes from spec 1's
baseline (§11). The two script conversions and the nine passes are governed by
one development-agent-gated switch (§8), so none of them reaches the fleet in
this build run.

## 4. Server-side job passes

### 4.1 Shape

A pass job's template becomes a spec-1 script that calls
`POST /jobs/:slug/pass` with the **`runId` of the run this machine claimed**.
The route:

- accepts only slugs on a code allowlist (`PASS_JOBS`) and only a `runId` this
  machine's scheduler started and has not finished; anything else is 409
  (`run-not-claimed`);
- runs at most one pass per slug and two in total at once, with at most one more
  queued per slug (a further request is answered with the existing `runId`);
- answers **202** with the `runId`; the work and the delivery happen on the
  server. The script waits on `GET /jobs/:slug/pass/:runId` for a terminal
  `outcome` and never re-posts; a second POST with the same `runId` returns the
  existing run.
- **One run lifecycle.** The scheduler's claim on the run is held until the pass
  reaches a terminal outcome, even if the script exits. A pass still running at
  twice the job's `expectedDurationMinutes`, or whose claim is lost (restart,
  lease loss), is cancelled; delivery checks that the claim is still held
  immediately before sending and is keyed by `runId`. The send goes through
  `sendAutomationReply`, whose durable origin outbox records the operation before
  dispatch and holds, never resends, an outcome it cannot confirm. The guarantee
  is therefore at most one send per `runId`, with an uncertain send held and
  visible rather than repeated; it is not exactly-once across a crash after
  Telegram accepted the message but before the outcome was recorded.
- **Fence every effect.** Each pass carries the claim epoch and run identity
  assigned at dispatch. The evolution-action write, checkpoint write, mark
  advance, handoff write and outbound send each reject a stale epoch before
  mutation. A lease transfer cancels the old worker; only the new claimant may
  resume the saved chunk. A mark advances only after every write in that chunk
  was accepted under the current claim. A stale worker can read but cannot
  mutate state, even if it passed an earlier claim check.

The pass, in order:

1. **Gather (deterministic).** The reads the old body made, assembled by code into
   a JSON document through `boundedInput.ts`, so any cut is disclosed inside the
   untrusted-data envelope the model sees. Each pass declares:
   - its byte cap, derived and recorded beside the constant: a quarter of the
     smallest context window on the pass's route chain, minus the fixed prompt;
   - its ordering (overseer reports: failing and skipped jobs first; relationship
     records: longest silence first; analyzers: as returned);
   - its **load-bearing** sections (the failing-jobs list, the routed learnings).
     If one cannot fit, the pass ends `outcome: input-incomplete` with no model
     call.
2. **Empty check (deterministic).** A gather empty by a declared rule ends with
   `outcome: nothing-to-do`, zero model calls.
3. **One routed call.** `IntelligenceRouter.evaluate()` with
   `attribution.component = 'JobPass/<slug>'` and explicit
   `attribution.jobSlug`, `attribution.machineId`, and `attribution.runId`, a fixed
   prompt per pass, the gather
   in an untrusted-data envelope, and strict JSON output `{ actionable: boolean,
   summary: string (≤600 chars), handoff: string (≤1000 chars) }`.
4. **Deliver through the automation reply chokepoint.** If `actionable`, the
   summary goes to the job's existing destination (its topic and `telegramNotify`
   policy) through `sendAutomationReply` (built on `postOriginAutomationReply`),
   as producer `job-pass/<slug>` with author contract `actual-call` naming the
   model that actually answered, so the credential-exposure guard, the outbound
   tone authority and message-origin recording all apply. The producers are added
   to the origin certificate inventory. `sendAutomationReply` is a closure in
   `server.ts`; it is injected into the pass runtime through the scheduler's
   dependencies. Calling `sendToTopic` directly, or an outbound check followed by
   `sendToTopic`, is forbidden for pass summaries. Destinations are fixed in code.
5. **Handoff.** The run is opened with `JobRunHistory.recordStart` before step 1,
   so `recordHandoff(runId, …)` attaches. The handoff is secret-scrubbed before
   it is stored. The next run's gather includes the last handoff as
   **model-authored untrusted data with its age**, below the deterministic facts,
   and the prompt says facts win. A handoff older than 3 runs is dropped.

### 4.2 Which model answers

Pass components are registered in `COMPONENT_CATEGORY` as `reflector`. With no
new routing code:

- with an active off-Claude framework: the off-Claude default and its
  failure-swap tail, ending on the agent default;
- on a Claude-only agent: the default framework (G4);
- once a pass has a bench task (§5.3): a row in `LLM_ROUTING_NATURE` (overseers
  and relationship-maintenance: nature D, chain `WRITE`; the two analyzers:
  nature B, chain `JUDGE`, because they decide whether a learning reaches a
  person), and the nature resolver picks the bench-cited position.

Until that row exists the run records `routeBasis: category-default`, never
`bench`.

### 4.3 Failure behaviour

Nothing unreviewed is ever sent to a person.

| Failure | Result |
|---|---|
| Router call errors after its swap chain | No message. `outcome: model-unavailable`. |
| Output fails the JSON schema | One retry, then `outcome: model-unusable`, no message. |
| Summary held by the credential guard or the tone authority | Not sent; `outcome: held-outbound`; nothing sent in its place. |
| Load-bearing input cut | `outcome: input-incomplete`, no call, no message. |
| Gather source answers 503 | `outcome: source-unavailable`, no call, no message. |

A `held-outbound` summary is a refusal of a report the operator would have
received, so it is never silent: the same run raises one attention item
(`conditionKey: job-pass-held:<slug>`) naming the job, the check that held it and
the run id, without the held text. For the other outcomes, after 3 consecutive
runs of one slug ending in any of them except `source-unavailable`, one attention
item is raised (`conditionKey: job-pass-degraded:<slug>`) saying the job has not
been able to report and why. Both close themselves on the next clean run.

### 4.4 Rollback

`jobs.passes.enabled: false`, or the slug in `jobs.passes.disabledSlugs`, read
live at trigger time: the scheduler runs the template body as a session (today's
behaviour). The body keeps the full runnable prompt for this reason, as spec 1
§8.4 does for script jobs. The same switch governs the two script conversions in
§3.

## 5. Benchmark-chosen pins for session jobs

### 5.1 The field and what executes

`JobDefinition` gains `framework?: IntelligenceFramework` and
`frameworkModel?: string`, carried in template frontmatter and added to the
loader's closed key set (spec 1 §8.5).

- **absent**: the agent default. Byte-identical to today.
- **present**: the job runs on that framework and exact model **when the pin is
  usable** (§5.2), else on the agent default.

`JobScheduler` passes both the framework and the exact model id to
`spawnSession`. If the spawn lands on a different framework or model than the pin
(closed lane, missing binary), the run records what actually ran and
`routeBasis: fallback`. Topic profiles and tier escalation do not apply to job
sessions today, and this spec does not make them apply.

### 5.2 When a pin is usable

Checked on every dispatch, on the machine that won the job's machine claim, from
in-process cached snapshots only (no network or disk call on the trigger path). A
missing or stale snapshot reads as unknown, and unknown means **not usable**.

1. The framework is in `enabledFrameworks`, its binary resolves, and the doorway
   snapshot does not report the door unreachable.
2. Its pool cell on this machine is not `needs-reauth`, walled, or above the
   proactive-swap threshold (cached pool state).
3. **Gate parity with the default.** `claude-code` is the reference: every
   default run already relies on its hooks, so a pin to it adds no new trust (a
   pin to `claude-code` only changes the model). `codex-cli` is usable only when
   (a) the per-slot trust summary from `codexHookTrust` reports every instar hook
   trusted at its current content hash (`allArmed`), with
   `codexHookContractCanary` passing as a pre-check, and (b) a **deny canary**
   passed within the last 7 days for the exact runtime version, hook content
   hashes, effective guard configuration and Codex slot identity in use now.
   Any change to those inputs invalidates the cached pass and makes the pin
   unusable until the canary reruns. The canary starts a throwaway Codex session
   (`codex exec --json`) in the project directory when the last pass is older
   than 7 days or an input changed. It tries one command matching a dangerous-command-guard
   deny pattern which is harmless if it runs: an `rm -rf` of a path that does not
   exist inside a fresh temporary directory, chained with creating a marker file
   in that directory. It passes only if the JSON event stream shows the deny for
   that command **and** the marker file does not exist afterwards. A deny with the
   marker present means the guard noticed but did not stop the command: the canary
   fails, one attention item is raised, and Codex is not usable. Other frameworks
   are not usable in v1 (§15.12).
4. The job's `toolAllowlist` is `"*"`, unless the framework enforces allowlists
   (only `claude-code` does).
5. The per-machine route breaker for this slug (§5.4) is closed.

Not usable → the agent default, `routeBasis: fallback`, with the first failing
check as `reason`. The run is never skipped because of routing.

### 5.3 Where the evidence comes from, and who chooses

1. **Bench.** INSTAR-Bench gains one task per pin candidate, `job:<slug>`. Repo
   fixtures are **synthetic or redacted** inputs shaped like the job's real inputs,
   with a deterministic grader where one exists (did it cancel the obsolete
   action; stay silent on a healthy window; propose only from learnings sharing a
   cause) and blind judging only for prose quality. Real recorded inputs, if used,
   live on the maintainer machine in an owner-only directory outside the repo and
   outside backups, and are never sent to a cross-model judge unredacted. Only
   predictions, counts and the prompt hash are mirrored into
   `benchmarkPredictions.json`. The same refresh re-benches the existing bounded
   tasks on the current Codex models (GPT-6 Luna and Sol).
2. **The choice is a PR.** A position may be proposed as a job's pin when its
   bench pass rate for `job:<slug>` is at least the agent default's on the same
   task minus 0.05, with an interval lower bound of at least 0.80, on a mirror
   whose `benchedPromptHash` equals the template body hash. These numbers are a
   screen for the PR's reviewer, not a switch. A ratchet test refuses a template
   pin without a matching, prompt-hash-current bench task. The existing monthly
   `bench-refresh` already raises a diff when a routing default looks stale; it
   covers job pins the same way.
3. **Trial before the fleet.** Each pin follows the maturation path. First a
   throwaway test agent (`/test-as-self`) runs the pinned job against the
   synthetic fixtures and must complete with its effects landed; then it takes
   effect where `jobs.routing` resolves on, which is development agents (§8);
   their production runs (§5.4) are the trial evidence quoted in the fleet PR.

Until a pin PR lands, every template carries no pin and runs exactly as today.

### 5.4 Production evidence and the route breaker

This machinery lands with the first pin PR (§12 step 3), not before: until a
pin exists there is nothing for it to watch.

Each pinned run is enrolled in the decision-quality meter as decision point
`job:<slug>`, graded by a new deterministic rule `job-run-effects`, owned by
`JobScheduler` and registered in the provenance census. Grades only ever **veto**;
they never qualify a pin.

- **wrong**: the run errored or timed out; or a declared effect is missing
  (checked on the effect's own surface: the file changed within the run window,
  the API record exists; never by reading the transcript, so Codex runs are
  covered); or the job's named revert signal fired within 7 days
  (evolution-overdue-check — an action it cancelled was reopened;
  evolution-proposal-evaluate — a proposal it approved was rejected or reverted;
  insight-harvest — a proposal it created was rejected as noise;
  reflection-trigger — its MEMORY.md lines were removed within 7 days per the
  agent repo's git history; where MEMORY.md is not tracked in git, this job has
  no revert signal).
- **not-wrong**: everything else. It is deliberately not called "right": an
  unnoticed bad action looks the same.

**Route breaker.** Three `wrong` grades on one pinned slug within 7 days on a
machine open that machine's breaker for the slug: the slug runs on the default
there, and one attention item is raised (`conditionKey:
job-route-breaker:<slug>:<machine>`). The breaker lives in
`state/job-route-breakers.json` (not as run rows); a missing file means closed, an
unreadable one means **open**. It closes only when a PR changes or removes the
pin (the record stores the pin's content hash); there is no reset route, so the
agent cannot reset its own safety brake.

**Weekly counterfactual sample.** One pinned run per slug per week is re-run on
the agent default as **one tool-less call**: the pinned run's gathered input is
put in the prompt, the model gets no tools at all, and it is asked to list the
actions it would take. Nothing it says can act. The pinned run's own action list
is taken from its declared effects on their own surfaces. The two lists are compared and the agreement rate is
reported in §11. It is a signal for the reviewer of the next pin PR, not a gate:
it is the one check that does not depend on the operator noticing a bad action.

### 5.5 Lean job context

- **Measure.** The session-start hook records, for job sessions (`INSTAR_JOB_SLUG`
  set), the byte size of each section it emits, into the run record.
- **Trim non-safety digests only.** A code allowlist names skippable sections
  (integrated-being entries, the memory index, the playbook digest, parallel-work
  awareness). A template with `leanContext: true` skips them. Safety sections
  (operator binding, standing rules, the Telegram relay rule, time, vault names,
  any gate injection) cannot be added; a test pins this.
- **Never cut what the job uses.** A section is skipped for a job only if the
  job's body neither reads nor writes that section's source (reflection-trigger
  writes MEMORY.md, so the memory index is never skipped for it). The session
  gets one line naming each omitted section and the endpoint that serves it, so
  the omission is disclosed and the content is one call away.
- **Leave CLAUDE.md alone.** Its share is reported, not changed.
- **When it is set.** After one measurement week, an agent PR sets
  `leanContext: true` on each session job whose skippable sections are at least
  10% of its start bytes; the job's `wrong` count (§5.4 rule, applied to any
  lean job) and a comparison of its effects before and after are quoted in the
  PR, and a rise reverts it.

## 6. commitment-detection as a pass, with Jev in front

### 6.1 What it does today, and what stays the same

Every 5 minutes the job starts a session that reads its bookmark, reads the last
100 lines of `telegram-messages.jsonl`, asks the model which new messages hold a
commitment, promise or action item, and records each as an evolution action
(`POST /evolution/actions`, `source.platform: commitment-detection`) with exactly
one follow-through choice: a resolved `dueBy`, or the fixed opt-out reason. Those
evolution actions are what evolution-overdue-check follows up.

This spec keeps all of that: the same messages, the same question, the same
record, the same store, and the same follow-up actor. Only the executor changes:
a server-side pass (§4) instead of a session, with Jev in front of the model call.
Nothing downstream changes, so no parity proof between different detectors is
needed.

`CommitmentSentinel`, the separate server-side detector of commitments the user
asked for, is untouched by this spec. Consolidating the two is a separate piece of
work, tracked by a commitment (§15.15).

### 6.2 The pass

commitment-detection becomes a pass job (class **pass** in §3), run every 5
minutes by a spec-1 script with no session. In order:

1. **Gather (deterministic).** Rows of this machine's `telegram-messages.jsonl`
   newer than a per-topic high-water mark (`state/commitment-pass.json`), excluding
   `provenance: automation` rows, read through the existing bounded tail reader.
   `topicId` already separates the main group from the issues group (the issues
   offset), so `(topicId, messageId)` is unique and per-topic marks do not skip
   messages. If a topic's mark is older than the oldest line in the window, the
   shortfall is counted and reported (`DegradationReporter`, naming the topic
   and the message range), never silent. On first run the marks start at the
   later of the start of the old job's last completed run and one hour ago
   (§9.5). The legacy scalar bookmark is imported once as a conservative hint;
   it cannot mark any topic past a row that the old executor did not inspect.
2. **Empty check.** No new rows → `outcome: nothing-to-do`, zero calls.
3. **Jev** (§6.3), per row.
4. **One routed call per chunk** of at most 10 rows, oldest first, as many chunks
   as fit in the run's time budget (at most 6; rows left over are drained by later
   runs, since marks advance per chunk), component `JobPass/commitment-detection`, category `reflector`, the
   old job's question, strict JSON output: items `{ row, title, description,
   dueBy | null }`, each naming the row index it came from.
5. **Write (deterministic).** The chunk's parsed items are first saved with the
   chunk (`state/commitment-pass.json`) under the current claim epoch, so a retry
   after a partial write reuses the same items in the same order. Each item
   becomes `POST /evolution/actions`
   exactly as the job wrote it, with the claim epoch checked at the action route,
   plus a new idempotency key `externalKey =
   promise:<topicId>:<messageId>:<n>`, where `n` is the item's position among the
   items from that message, so a message with two promises keeps both. The route
   honours the key (a second write with the same key returns the existing action;
   spec 1 §7 asked for a per-message key). The
   follow-through choice is the job's: `dueBy` when resolved, else the fixed
   opt-out reason.
6. **Marks** advance per chunk, only after that chunk's writes succeed and only
   under the current claim epoch. A chunk whose call fails is retried on the next
   run; after 6 hours of failures for a
   topic the mark advances and the skipped rows are counted and reported.

The pass sends no message: the job never did. A run that cannot classify rows,
or is cancelled at its time limit, counts toward the §4.3 degraded item (3
consecutive). The template's `expectedDurationMinutes` becomes 4, so the §4.1
cancel limit (twice that) sits above the worst case of 6 chunks, each bounded by
the router's swap timeouts, plus Jev's per-run budget of 30 seconds. The pass
holds one of the two global pass slots while it runs, like any pass.

**Single-provider path (G4).** No Jev: every new row goes to the routed call, which
on a Claude-only agent is the default framework. That is the job's behaviour today,
minus the session.

**Multi-machine.** As today: the job runs on the machine that wins its claim and
reads that machine's log, and its marks are that machine's. This spec does not
change the job's coverage across machines; it changes how each run executes.

**Amendment of spec 1 §7.** Spec 1 asked for event-driven detection at message
ingest, with no cron cursor and a `(chatId, messageId)` key, because of three
problems with a single numeric bookmark. This spec keeps a 5-minute server-side
poll instead, and resolves each problem directly: per-chat message ids are
handled by per-topic marks, and `topicId` already identifies the chat (the issues
group's topics carry its offset), so `(topicId, messageId)` is the same identity
as `(chatId, messageId)`; the lease-move and active-active coverage limits are
unchanged from today's job and are not made worse. A poll costs nothing when
nothing new was written (the empty check makes no call), and keeps one executor
model shared with the other passes. Moving to ingest events is folded into the
`CommitmentSentinel` consolidation follow-up (§15.15).

### 6.3 Jev in front of the model call (cascade)

1. **Jev** answers, per row, one question (does this message contain a commitment,
   promise or action item / no / a report of something already done / cannot
   tell), both option orders in one call, on the scrubbed message. Topics in
   `intelligence.jevPromisePass.excludedTopics` never go to Jev.
2. **Confident no** on a live machine requires a valid response in both option
   orders, both selecting the explicit `no` label for the same row, with
   P(yes) < 0.30 in each order. A missing, malformed, `cannot tell`, reversed
   disagreement, or merely low-probability answer is never a confident no.
   Only a valid confident no may drop the row before the model call.
3. **Anything else:** the row goes to the routed call, which is the referee (Codex
   `fast`, GPT-6 Luna, where active and bench-cited; the agent default otherwise).
   A confident yes still needs it for the title and deadline.
   This extraction is the commitment job's required work, including after a
   positive or uncertain Jev label. It does not make Haiku or Luna a routine
   second opinion for spec 1's scheduled-result triage: that path uses Jev alone
   when confident and a backup only during Jev outage.
4. **Audit:** `intelligence.jevPromisePass.auditRate` (default 0.05, and at least
   5 rows a week) of confident-no rows still go to the call, both in shadow and
   after going live.

**Bounds.** `intelligence.jevPromisePass.dailyCap` (default 600), at most 2 calls in
flight, a per-run time budget of 30 seconds, the `JevCorrectionShadow` timeout. Past any bound,
rows go to the call.

**Shadow first** (`dryRun: true`): Jev is asked and logged
(`logs/jev-promise-pass.jsonl`, content-free), every row still goes to the call.

**Screen for dropping** (an agent PR setting `dryRun: false`, quoting numbers).
Outcomes here are slow: evolution-overdue-check runs only when something is past
its `dueBy`, and actions recorded with the opt-out reason never become overdue, so
most actions settle only when the agent closes them. The screen therefore uses two
measurements and requires both:
- **The referee's verdict, available at once.** Among at least 300 confident-no
  rows in shadow, every one also went to the routed call (shadow drops nothing);
  the call found a commitment in at most 1% of them.
- **Settled outcomes, with a horizon.** An action from a confident-no row is
  settled when it is `completed`, or cancelled with a done-or-not-needed reason,
  within 14 days; anything else is `unknown`, never counted as "not a
  commitment". The screen needs at least 10 settled actions from confident-no rows
  (accumulating across shadow weeks if necessary) and none of them `completed`. Until
  10 have settled, the screen is not met, however good the first number looks.

After it goes live the audit share continues. An audited confident-no row on which
the call finds a commitment that is `completed` within 14 days, or more than 1% of
audited rows over a rolling 30 days on which the call finds one at all, turns
dropping off on that machine
(`state/jev-promise-pass-breaker.json`; missing = closed, unreadable = open) and
raises one attention item. Re-enabling is a PR.

**Savings** are counted as model calls avoided (a chunk with every row
confident-no), next to Jev's own call count.

## 7. Jev "nothing to do" pre-gate (two session jobs)

For reflection-trigger and insight-harvest, Opus sessions that usually find
nothing, Jev answers one question over the bounded input before the session is
spawned: "Does this contain something worth acting on?" (yes / no / cannot tell,
both orders).

- **Input.** reflection-trigger: the activity-log window its body extracts, built
  server-side by the scheduler before the spawn. insight-harvest:
  `GET /evolution/learnings?applied=false`. Secret-scrubbed (`scrubForStore`)
  before it leaves the machine.
- **Confident no** means valid answers in both option orders explicitly select
  `no`, agree on the label, and each reports P(no) ≥ 0.70. Missing, malformed,
  `cannot tell`, or order-disagreeing answers proceed to the session. On a slug in
  `intelligence.jevJobPregate.liveSlugs` it ends the run, `outcome: jev-quiet`.
  Anything else: the run proceeds.
- **Shadow.** For slugs not in `liveSlugs` every run proceeds, and each
  confident-no is graded against the full run, **only when the run completed
  cleanly**: `wrong` if it produced an effect or a notification, `right` if it
  produced neither. A run that errored, timed out or was cut short is `unknown`
  and does not count.
- **Screen for adding a slug to `liveSlugs`** (an agent PR quoting the numbers):
  at least 30 graded confident-no rows from clean runs, none `wrong`.
- **Live audit.** After a slug goes live, its confident-no runs still proceed at a
  rate of 1 in 10, and at least one a week. A single `wrong` trips the slug's
  breaker on that machine (`state/jev-pregate-breaker.json`; a missing file means
  closed, an unreadable one means open), stops skipping for that slug, and raises
  one attention item. The breaker resets only when a later PR changes `liveSlugs`
  for that slug, detected by the `liveSlugs` content hash stored in the trip
  record.
- **Bounds.** `intelligence.jevJobPregate.dailyCap` (default 100) and the
  `JevCorrectionShadow` timeout. Cap reached or Jev down: the run proceeds.
- **No referee.** An unsure answer runs the job, the safe direction.
- **No Jev:** no pre-gate; today's behaviour.

The other pass jobs get no pre-gate: a pass is already one bounded call, and a
pre-gate there would save one call at the cost of its own grading machinery. The
commitment-detection pass is the exception because it classifies many rows per
run, and there Jev works per row (§6.3).

## 8. Configuration

Added by `migrateConfig()` only when missing:

```json
"jobs": {
  "passes": { "disabledSlugs": [] },
  "routing": {}
},
"intelligence": {
  "jevPromisePass": { "dailyCap": 600, "auditRate": 0.05, "excludedTopics": [] },
  "jevJobPregate": { "dailyCap": 100 }
}
```

The go-live switches are **code defaults, not written into config**:
`intelligence.jevPromisePass.dryRun` (default true) and
`intelligence.jevJobPregate.liveSlugs` (default empty) are never added by
`migrateConfig()`. A go-live PR changes the code default, so every agent that has
not set its own value receives it on update; an explicit value in an agent's
config still overrides. The pre-gate breaker's trip record stores the hash of the
effective `liveSlugs` (code default merged with any override).

`jobs.passes.enabled`, `jobs.routing.enabled`, `intelligence.jevPromisePass.enabled`
and `intelligence.jevJobPregate.enabled` are **omitted**, so each rides the
development-agent gate: live on a development agent, dark on the fleet. Explicit
`false` is the kill switch. All are read live. `jobs.passes` governs every pass,
commitment-detection included, and the two script conversions (§4.4). Taking any
piece to the fleet is a separate later PR (§12).

## 9. Migration parity

1. **Templates.** Changed in `getDefaultJobs()` and regenerated. The installer
   overwrites `.instar/jobs/instar/<slug>.md` and regenerates manifests on every
   update while keeping `enabled` (spec 1 §8.1). Where a piece is dark, its
   template body runs as a session on the default, as today.
2. **Loader keys.** `framework`, `frameworkModel` and `leanContext` join the closed
   key set in the same package version as the templates; spec 1's pin test covers
   them.
3. **Run records.** `JobRun` gains optional `runner`, `framework`, `model`,
   `routeBasis`, `reason`, `outcome`. Old rows read back with `routeBasis:
   unknown`. Breaker records are separate files, never `JobRun` rows.
4. **Evolution actions.** `POST /evolution/actions` accepts an optional
   `externalKey`, stored on the action and looked up on write; a second write with
   the same key returns the existing action. The `promise:` prefix is reserved for
   the pass and the session template; any other caller using it is refused. The
   dedupe is per machine (replication fingerprints actions by title, target and
   creation time). Existing actions have none and are unaffected.
5. **commitment-detection marks.** On first pass or upgraded-session run the
   per-topic marks start at the later of the **start** of the old job's last completed run (when it read
   the log) and one hour ago, so nothing that arrived during that run is skipped,
   and a machine whose old job last ran weeks ago does not replay a backlog of
   stale promises; the gap, when there is one, is reported. Rows the old job's last
   run already recorded may be recorded once more (its actions carry no key); that
   is at most one run's worth, once. With no run history the marks start at
   "now". The legacy scalar bookmark is read only for this one-time migration;
   per-topic marks become the sole cursor for both executors. Import scans the
   bounded retained history by topic and never applies one topic's maximum id to
   another topic. If the retained window cannot prove coverage, report the gap
   and start at the conservative lower mark.
6. **Config.** §8, existence-checked.
7. **User forks.** Reported once in `logs/job-runner-migration.jsonl` and flagged
   in `GET /jobs`, never rewritten (spec 1 §8.3).
8. **Agent Awareness.** `generateClaudeMd()` / `migrateClaudeMd()` (content guard)
   add a short section: some jobs can run as one server-side pass, and some can be
   pinned to a benchmark-chosen model, both live on development agents and dark on
   the fleet until enabled; `GET /jobs` shows each run's `framework`, `model`,
   `routeBasis`, `reason`, `outcome`.
9. **Backups.** `state/commitment-pass.json`, `ledger/job-runs.jsonl` and the
   breaker files are added to the BackupManager manifest; logs are excluded.
10. **Rollback.** Every piece has a live switch (§8), and no piece rewrites a user
    file. Removing a pin is a template change shipped like any other. With passes
    off, commitment-detection runs as its session again. Both executors use the
    same per-topic marks in `state/commitment-pass.json` and the same
    `externalKey`; neither advances the old global scalar bookmark. The scalar
    bookmark is read only during the one-time migration in §9.5. A two-topic
    interleaving cannot hide a lower message id in the other topic when the
    switch flips in either direction.

## 10. Multi-machine posture

- **Pin usability snapshots, deny-canary result, route breakers** — machine-local.
  machine-local-justification: physical-credential-locality — whether a pin is
  usable, and how well it ran, depends on this machine's framework login, binary
  and armed hooks; the job's machine claim picks the one machine that runs each
  fire.
- **Job passes** — `JobRunHistory`, the existing store and posture for every job
  run; no new store.
- **commitment-detection marks and the Jev breakers** — machine-local.
  machine-local-justification: physical-credential-locality — the marks index this
  machine's Telegram history file, which records the sends made through this
  machine's bot binding, and the breakers record calls made with this machine's
  Jev key. This is the same posture as the old job's bookmark.
- **Evolution actions** — the existing store and posture, unchanged.
- **Jev shadow rows, grades, cost rows** — proxied-on-read: `GET /decision-quality`
  and `GET /jobs/cost` accept `?scope=pool` and merge across machines (bounded to
  the requested window and 1,000 rows per machine); a peer that cannot be reached
  is reported as missing, never as zero. Logs rotate at 30 days.
- **Routing baseline** — proxied-on-read through `GET /jobs/cost?scope=pool`,
  stored per machine like spec 1's baseline.
- **Bench mirror and pins** — in the package; identical everywhere.

## 11. Measurement (before and after)

Built on spec 1's §9 machinery; nothing parallel.

1. **Baseline.** Spec 1's 7-day measurement window, per slug and machine,
   frozen into `.instar/state/job-routing-baseline.json`. Before each conversion,
   collect daily evolution-action counts for commitment-detection and the
   before-state `wrong` or effect counts for pin candidates, alongside tokens,
   runs and failures. If a historical surface cannot support a count, mark that
   metric `unmeasured` and do not claim a quality delta or graduation from it.
   Commitment-detection's real cost comes from spec 1's baseline, which counts it separately.
2. **Per run** (run history): `runner`, `framework`, `model`, `routeBasis`
   (`bench` / `category-default` / `default` / `fallback`), `reason`, `outcome`,
   tokens. Every pass, retry, provider-swap, Jev and counterfactual call carries
   explicit `jobSlug`, `machineId` and `runId` attribution. The cost ledger
   groups by `jobSlug` and counts each provider attempt once, including both
   attempts in a swap; a component name alone is insufficient.
3. **Codex attribution.** Spec 1's `job_sessions` row gains `framework` and
   `framework_session_id`. For Codex the rollout id is recorded **when it is
   discovered** after spawn; until then, and if never, the session is counted
   `unmapped`, never dropped and never counted as zero.
4. **`GET /jobs/cost`** adds per slug the framework/model mix, the share ended by
   the empty check or the pre-gate, and the Claude-quota share.
5. **Quality.** Per pinned slug: `wrong` counts before and after the pin, breaker
   trips, and the weekly counterfactual agreement. For commitment-detection:
   evolution actions recorded per week before and after the switch, the share
   later completed or cancelled, rows skipped after failures, model calls avoided
   by Jev and Jev's own calls, and the §6.3 shadow numbers.
6. **Report.** Seven days after each piece goes live on a machine: one report to
   the job log and the Updates topic with before/after tokens per slug, Claude
   quota share, quality numbers, and one raw run quoted end-to-end. A slug whose
   `wrong` count, or for commitment-detection whose weekly action count, moved by
   more than twice the baseline's daily standard deviation is flagged for a human
   look.
7. **Single-provider first.** On a development agent each piece's single-provider
   path (category-default passes on a Claude-only config, no Jev, no pre-gate, no
   pin) is measured for its own week before the multi-provider numbers are
   reported.

### Verify the state, not its symbol

| Signal | State it claims | Corroboration | When unmeasurable |
|---|---|---|---|
| Bench pass rate, `job:<slug>` | This model does this job about as well as the default | Development-agent trial `wrong` counts + weekly counterfactual agreement, read by the fleet PR's reviewer | No pin is proposed |
| `job:<slug>` `wrong` | The pinned run failed or was undone | The effect's own surface; the named revert signal | `not-wrong`, which never qualifies anything |
| Codex gates enforce | Instar's blocking gates stop a command on that session | Deny canary: a deny event for the canary's command **and** its marker file absent | Pin not usable |
| Jev confident-no on a row | The message holds no commitment | The pass model's verdict on the same row (shadow and audit share) and whether that action was later completed | Row goes to the model call |
| Pass `nothing-to-do` / marks | Every new message was looked at | Marks advance only after writes; shortfalls and skips are counted | Counted as skipped, reported |
| Jev "nothing to do" (pre-gate) | The session would have done nothing | Clean-run grading in shadow and the live audit | Run proceeds |
| Token totals | Cost fell | Ledger rows joined by session id, per framework | `unmeasured`, with the unmapped count |

## 12. Rollout

**This build run covers steps 1 and 2.** Later steps are separate PRs by the agent,
each quoting the numbers named for it.

1. Ship: the `framework` / `frameworkModel` fields with usability checks 1, 2 and 4
   and the fallback; the pin ratchet; the pass runtime; the evolution-action
   `externalKey`; Jev in front of the commitment-detection pass, in shadow; the
   pre-gate in shadow. No template carries a pin.
2. On development agents: convert rope-health-digest and org-intent-drift-audit to
   scripts and the 9 pass jobs, commitment-detection included, to passes
   (category-default routing).
3. Bench refresh on the maintainer machine (GPT-6 Luna / Sol on the existing tasks
   plus the four `job:<slug>` tasks). The first pin PR also lands the route
   breaker, the `job-run-effects` grader and the counterfactual sample (§5.4); the
   first `codex-cli` pin PR also lands the deny canary (§5.2). Each pin runs on a
   throwaway test agent first, then on development agents (§5.3).
4. Jev dropping in the commitment-detection pass: per §6.3 by PR.
5. Pre-gate: per slug, added to `liveSlugs` by PR per §7.
6. Lean context: one measurement week, then per §5.5.
7. Fleet: one PR per piece after its development-agent report (§11.6).

## 13. Tests (three tiers)

**Unit**
- Pin usability: each check on both sides with its `reason`; unknown snapshots are
  not usable; a restricted allowlist never runs on Codex; Codex not usable without
  a fresh canary pass and `allArmed`; bench-refresh carries no pin; the run is
  never skipped because of routing.
- Ratchet: a template pin without a prompt-hash-current bench task fails.
- `job-run-effects` (with the first pin): errored, missing effect and fired revert
  signal are `wrong`; everything else `not-wrong`; an untracked MEMORY.md means no
  revert signal.
- Route breaker (with the first pin): three `wrong` in 7 days opens it; missing
  file closed, unreadable file open; reset only by a pin change.
- Deny canary (with the first Codex pin): a deny event with the marker absent
  passes; a deny event with the marker present fails and raises one item; no event
  fails; it reruns when the last pass is older than 7 days or any bound runtime,
  hook hash, guard configuration or slot identity changes. A cached result for
  former inputs never makes the current pin usable.
- Pass route: unclaimed `runId` → 409; non-allowlisted slug → 409; repeat POST
  returns the existing run; one running and at most one queued per slug; cap
  derivation; load-bearing cut → no call; empty → no call; schema failure retries
  once then sends nothing; a summary with a planted credential is held by
  `sendAutomationReply`, nothing is sent in its place and the held item is raised
  on the same run; 3 degraded runs raise one item that clears on a clean run;
  handoff scrubbed, enveloped, aged out; a pass past its limit or with a lost
  claim is cancelled and cannot deliver; delivery is idempotent by `runId`.
- Claim fencing: transfer the lease between gather and each mutation boundary;
  stale workers cannot write a chunk, action, cursor, handoff or send a summary;
  a new claimant resumes partial writes with the same idempotency keys and only
  then advances the mark. Verify provider swap calls carry the same explicit
  `jobSlug`, `machineId` and `runId`, with each cost row counted once.
- commitment-detection pass: automation rows ignored; per-topic marks across the
  main and issues groups; the mark does not advance past a failed call or failed
  write; after 6 hours it advances with a counted skip; a window shortfall is
  counted; each item maps to its row; at most 10 rows per call; the evolution
  action carries `dueBy` or the opt-out reason, and `externalKey`; a repeated
  write returns the existing action; first-run marks start at the old job's last
  run, or an hour ago if that is later; the pass and session share per-topic
  marks and the same `externalKey`; interleaved topics survive rollback; a
  cancelled run counts as degraded.
- Jev label boundaries: both orders valid matching `no` can drop or skip when
  their respective threshold is met; low probability alone, `cannot tell`,
  malformed output and disagreement in either order always proceed.
- Baseline: daily actions and effects are collected before conversion; a missing
  historical metric is `unmeasured` and cannot satisfy a quality gate.
- Jev in that pass: shadow never drops; confident-no drops only when live; the
  audit share (default 0.05, at least 5 a week) still calls the model; unsettled
  actions are `unknown` and the screen needs 10 settled; excluded topics never reach Jev; cap or Jev
  down → model call; breaker missing closed, unreadable open; no Jev → every row
  to the call; savings counted per avoided call.
- Pre-gate: scrubbed input; shadow never skips; errored runs graded `unknown`;
  live skip only for `liveSlugs`; at least one live audit a week; one `wrong`
  trips the breaker; reset only on a `liveSlugs` change.
- Lean context: the allowlist cannot contain a safety section; a section the job's
  body reads or writes is never skipped; omissions are listed in the session.

**Integration**
- `POST /jobs/:slug/pass` → 202 → terminal outcome with a stub provider; delivery
  through `sendAutomationReply` with producer `job-pass/<slug>` only; handoff stored
  and fed back.
- The commitment-detection pass over a fixture history writes the same evolution
  actions the old job's instructions describe, and a second run writes none.
- `GET /jobs` shows route fields; `GET /jobs/cost?scope=pool` merges and reports an
  unreachable peer as missing.

**E2E (production init path)**
- A server built like `server.ts` boots with the pass runtime, pin checks and the
  Jev layer wired (not null, not no-ops); a pass run answers 202 and reaches a
  terminal outcome.
- A pinned job on a Claude-only config runs on `claude-code` with
  `routeBasis: fallback` (the single-provider floor is alive).
- With passes on, commitment-detection runs with no session; with passes off it
  runs its session as today.

## Maturation plan

- **test-agent-live:** a throwaway agent (`/test-as-self`) on one machine with the
  nine passes and two scripts enabled and a fixture Telegram history. Run each pass
  once on a normal fixture and once on an empty one, and observe the run record,
  the zero sessions, one summary sent through `sendAutomationReply`, a planted
  credential held with its attention item, and the commitment pass writing the
  same evolution actions the old job's instructions describe, then none on a
  second run. For each later pin PR, the pinned job runs here first on its
  synthetic fixtures (§5.3).
- **dev-agent-live:** §12 steps 1 and 2 on the development agents (Echo first) for
  7 days, with `jobs.passes` and `jobs.routing` riding the development-agent gate
  and Jev and the pre-gate in shadow. Later steps follow the same path, each with
  its own screen (§5.3, §6.3, §7).
- **fleet:** one PR per piece (§12 step 7), removing it from the development-agent
  gate, carried to existing agents by `installBuiltinJobs()` and the code defaults
  (§8, §9). Each fleet PR states the Jev egress it brings (§15.11).
- **graduation criterion:** over the 7 development days, read from `GET /jobs/cost`
  and run history, never inferred:
  - zero sessions for the passes and scripts, with run counts matching the
    baseline allowing for cron skips;
  - no pass delivered anything on a failed or held run, and every held summary
    raised its item;
  - the commitment pass's weekly evolution-action count within twice the
    baseline's daily standard deviation, with no rows skipped after retries;
  - the single-provider path measured for its own week first (§11.7);
  - one raw run per slug read end to end.

  A zero count of runs is not a pass.
- **dark-window:** at most 21 days from merge to the first fleet decision. If the
  criterion is not met by then, the reason and a new date are recorded on the
  rollout commitment for that piece. No piece is left dark silently; the
  evidence-gated later steps (pins, Jev dropping, pre-gate skipping, lean context)
  each carry their own commitment from the day this spec is accepted.

## 14. Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Pin usability: run on the pin or on the default | **invariant** | Deterministic availability and safety checks; unknown is not usable; the default is always reachable and the run is never skipped. Which model to pin is decided upstream by a reviewed PR over bench evidence. |
| Route breaker | **invariant** | A safety brake: three `wrong` grades in 7 days; unreadable state counts as open. |
| `job-run-effects` grading | **invariant** | Deterministic checks of effects on their own surfaces and named revert signals; only ever vetoes. |
| Pass: actionable, and the summary text | **judgment-candidate** | Floor: deterministic empty check; nothing sent on any failure; fixed destinations; `sendAutomationReply`'s credential guard and tone authority. Arbiter: the routed model. |
| Pass: held and degraded-run attention items | **invariant** | A held summary is reported on the same run; other failures after a fixed count of 3; fixed text. |
| commitment-detection pass: does a message hold a commitment | **judgment-candidate** | Same question, record and store as the job today. Floor: every row reaches the routed call unless Jev is live and confident; failed calls hold the mark. Arbiter: the routed model. |
| Jev drop in that pass | **judgment-candidate** | Floor: the row goes to the model call. Only a confident Jev no on a live machine drops it, after the §6.3 screen on completed actions, with an audit share and a breaker. |
| Pass mark advance after repeated failure | **invariant** | Fixed 6-hour limit; the skip is counted and reported. |
| Jev pre-gate: skip a session | **judgment-candidate** | Floor: run the job. Only a confident Jev no on a live slug skips; live audit plus a durable breaker. |
| Lean context: sections to omit | **invariant** | Code allowlist of non-safety digests the job does not use; a test refuses safety sections; omissions are disclosed. |

## 15. Frontloaded Decisions

1. **commitment-detection becomes a pass with the same question, record, store and
   follow-up actor**; only the executor changes (§6). No new detector.
2. **`CommitmentSentinel` is untouched**; consolidation is a tracked follow-up.
3. **Jev sits in front of the pass's model call** and only drops rows it is
   confident hold nothing (§6.3).
4. **Evolution actions gain an `externalKey`**,
   `promise:<topicId>:<messageId>:<n>`, one per promise in a message (§6.2).
5. **Jev dropping is judged on the referee's verdict and on settled outcomes**,
   never agreement alone (§6.3).
6. **Session-job routing is a benchmark-chosen pin set by PR**, not a runtime
   resolver; the run falls back to the default whenever the pin is not usable
   (§5). A runtime resolver was cut for proportion.
7. **Pin screen:** default − 0.05 and interval lower bound 0.80, prompt hash
   current (§5.3); production grades only veto (§5.4).
8. **Four pin candidates** (§3); evolution-proposal-implement stays on the default;
   bench-refresh is never pinned.
9. **No metered doors** in any pin.
10. **Codex is usable only with a fresh deny-canary pass and all hooks trusted at
    current hashes** (§5.2); the canary, breaker, grader and counterfactual land
    with the first pin PR that needs them (§12).
11. **Jev egress.** Scrubbed text goes to TypeSafe under the development-agent
    gate, following the `JevCorrectionShadow` precedent (which already sends user
    messages and the agent's previous message): each new Telegram message the
    commitment pass reads and, for the pre-gate, the activity window and the
    unapplied-learnings list. Topics in `excludedTopics` never go. Each fleet PR
    states this egress explicitly. Relationship records never go: the relationship
    pass has no Jev step.
12. **Other frameworks (Gemini, pi, Grok) are not pin targets in v1**; adding one
    needs its own deny canary, tracked by a commitment.
13. **This build run is rollout steps 1–2** (§12).
14. **Fleet enablement is a separate PR per piece** (§8, §12).
15. **Promise detection stays Telegram-only, as today**; consolidating it with
    `CommitmentSentinel` and adding Slack are tracked follow-ups.
16. **Nothing unreviewed is sent on a pass failure**, and pass summaries go through
    `sendAutomationReply` as producer `job-pass/<slug>` (§4.1, §4.3).
17. **The two script conversions are governed by the `jobs.passes` switch**, so
    they do not reach the fleet in this build run (§3, §8).
18. **The pre-gate is limited to reflection-trigger and insight-harvest**, with
    confident-no at P(no) ≥ 0.70 (§7).
19. **`leanContext` threshold: 10% of start bytes**, never cutting a section the
    job uses (§5.5).
20. **Pass components are category `reflector`** (§4.2).
21. **Breakers reset only by PR**; there is no reset route (§5.4, §6.3, §7).
22. **A pass holds its run claim until a terminal outcome**; delivery is
    claim-checked and idempotent by `runId` (§4.1).
23. **Go-live switches are code defaults**, so a go-live PR reaches every agent
    that has not overridden them (§8).
24. **The commitment pass's Jev audit rate is 0.05, at least 5 rows a week**, and
    its drop screen needs 10 settled outcomes within a 14-day horizon (§6.3).
25. **Spec 1 §7's event-driven ingest is amended to a server-side poll** with
    per-topic marks, for the reasons in §6.2; ingest events move to the
    consolidation follow-up.
26. **Pass delivery is at most once per `runId`**, with uncertain sends held by the
    origin outbox, not exactly-once (§4.1).

## 16. Open questions

*(none)*
