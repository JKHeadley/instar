---
title: "Projection Calibration — every estimate is recorded, measured against what happened, and used to correct the next one"
slug: projection-calibration
author: echo
parent-principle: "Decision Provenance & Outcome Review"
eli16-overview: docs/specs/projection-calibration.eli16.md
origin: "Telegram topic 144319, Justin 2026-11-17 13:48 PST (message 4585561398643510): start comparing projections with actual milestones for all Instar agents, record the conditions, make it its own project. Project topic 144374."
lessons-engaged:
  - "Structure beats Willpower (actuals come from external events, not memory; the calibration read is the response to recording an estimate)"
  - "Signal vs. Authority (the correction and the unrecorded-estimate note inform; nothing here blocks a message or rewrites an estimate)"
  - "Verify the State, Not Its Symbol (only actuals written by GitHub or a person feed the correction)"
  - "Quantitative Claims Must Bind a Subject (every number names its task type, conditions, kind of time, sample size and source)"
  - "No Unbounded Loops (one reconcile pass with a read budget, per-check backoff and a breaker)"
  - "The Agent Carries the Loop / Close the Loop (an open projection past its estimate stays visible and is reported beside the median)"
  - "Cross-Machine Coherence Standard A (one replicated store, no machine-local surface)"
  - "Never-Waste Feedback (a missed estimate becomes a number the next estimate reads)"
  - "Occam's Razor (review cut the activity meter, five check forms, the document and sentinel capture and the ranking)"
review-convergence: "2026-11-17T22:35:19.289Z"
review-iterations: 5
review-completed-at: "2026-11-17T22:35:19.289Z"
review-report: "docs/specs/reports/projection-calibration-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 19
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Projection Calibration

## Problem statement

Instar agents give time estimates all day: to a person in chat ("this will take about a week"), in plans, in specs, in autonomous-run briefs. Nothing records them, nothing compares them with what happened, and so every estimate is a fresh guess with the same bias as the last one.

The case that started this: on 2026-11-17 a reviewed plan (four review rounds, three model families) projected 4-6 weeks for the Windows app to reach Mac parity. Justin's reading, from watching these agents work: functional within 24 hours of an autonomous session, 48 at most. His words: "you are vastly vastly underestimating yourself". If he is right the plan was off by more than ten times, and no part of Instar could have told the agent so before it wrote the number.

Three things make agent estimates wrong in ways a ledger can fix:

1. **The agent estimates like a human team.** Its training data is human project timelines. Only its own history can teach it its own speed.
2. **Conditions change the answer and are never stated.** Autonomous or interactive, which model designs and which builds, which machine, how many sessions in parallel, how many review rounds.
3. **Waiting is mixed into working.** An approval that sits overnight, the verification and merge line. These often dominate elapsed time, and an estimate that does not separate them cannot be checked or corrected.

## What already exists (reused) and what is new

Checked on main at `17d763d89`. Nothing in the codebase records a time estimate made to a person or in a plan, and there is no correction factor anywhere.

| Existing piece | What it has | How this spec uses it |
|---|---|---|
| Replicated record stores (`WorkCardStore.ts`, `ChiefOfStaffStore.ts`) | Immutable records, folded into a view, replicated across an agent's machines | The projection ledger is one more store of the same construction. |
| Chief of Staff done checks (`ChiefOfStaffEvidence.ts`) | Reads `PR owner/repo#N merged` through the GitHub API for a bound project's linked repos; returns pass / fail / unknown | The same check text and the same GitHub read. The evaluator needs one small extension: it returns pass/fail/unknown only, and this spec needs the merge time, so the GitHub read is factored into a shared helper that also returns `merged_at` and `created_at`. The Chief of Staff binding guidance gains one line (section 6). |
| Work Board (`WorkCardStore.ts`) | Cards with `createdAt`, `taps[{action, by, at}]` written by a verified person | The time from an approval ask to the person's tap is the corroborated person-wait for a linked projection. A person's done tap is one way a milestone is confirmed. |
| Message log with authorship (`/attribution/*`, Telegram/app history rows with `authorship: human`) | Which messages a person really wrote, and when | A person's own projection, and a person's "yes, that works" confirmation, are recorded only against a logged human-authored message. |
| Local Verify record (`src/localVerify/record.ts`) | `startedAt`, `finishedAt`, `outcome` per PR head, per machine | Not used as a finish line: a first passing run on an early head would date a milestone too soon, and in this pipeline a merge already requires a passing run. Verification time is part of pipeline time. |
| Unified usage ledger (`src/monitoring/UsageLedger.ts`) | Per-call rows with `framework, model, machine_id, session_id, session_kind, parent_session_id, run_id`, per machine | Observed conditions: which models and frameworks actually ran, and how many sessions and subagents. Not used to measure time (see "What review removed"). |
| Autonomous runs (`AutonomousRunStore.ts`) | A run record exists for a topic with `startedAt`, `endedAt` | Tells the server a projection was made inside an autonomous run, so `mode` is observed, not declared. |
| Outbound preflight (`POST /messaging/preflight`, `src/messaging/OutboundAdvisory.ts`, the `TIME_CLAIM` check) | A check of each outgoing message before it is sent; advisories hold the message until the agent acknowledges them | The unrecorded-estimate note is computed on the same route and returned in a separate field that does not hold the message (section 6). |
| Session-start hook (`PostUpdateMigrator.getSessionStartHook()`) | Injects short blocks at every session start; always overwritten on update | One short fixed block (section 4). |
| Telemetry (`src/monitoring/TelemetryCollector.ts`, `BaselineSubmission`) | Opt-in numbers to the Instar telemetry endpoint; already carries job `durations` and `models` | The channel for other installs' pooled numbers (section 7). |
| CommitmentTracker, PromiseBeacon | Dated promises, delivery, blocker episodes whose class the agent declares | A projection can link a commitment for display. Its `delivered` event and its blocker episodes do **not** feed the correction, because the agent writes both. Unchanged. |
| Failure-Learning Loop, Growth & Milestone Analyst, Blocker Lifecycle ledger, Queue Pace, Session Clock, Initiatives, job `expectedDurationMinutes` | Failure forensics; days-in-stage; blocker clear latency; `daysToClear`; run clock; phase times; a config duration per job | Not extended and not changed. None of them holds an estimate given to anyone. An initiative id is an optional link on a projection. |

**New in this spec:** the projection ledger, the reconcile pass that writes actuals, the wait split, the calibration read, the session-start line, the unrecorded-estimate note, and the fleet prior file.

## Vocabulary

- **Projection**: one statement of how long one thing will take, made by an agent or a person.
- **Milestone**: a state of the world with a check a machine can evaluate. One projection has one milestone. A plan with five milestones is five projections sharing a `group`.
- **Actual**: the time the milestone's check first passed, with its evidence and who wrote that evidence.
- **First estimate**: what the agent wrote before the server showed it its track record. **Stated estimate**: what it then told the person.
- **Elapsed time**: from the moment the estimate was recorded to the actual. **Person wait**: time between an ask to a person and their answer. **Pipeline time**: time a linked pull request was open before it merged; reported beside the result, not subtracted. **Net time**: elapsed minus recorded person waits. It exists only where the wait was recorded.
- **Ratio**: actual divided by estimate, for the same kind of time. 0.1 means it took a tenth of the estimate. For a range estimate the denominator is the geometric mean of low and high (for "4-6 weeks", 4.9 weeks).

## Proposed design

### 1. The projection record

A new replicated store `ProjectionStore` (`src/core/ProjectionStore.ts`), kind `projection-record`, built like `WorkCardStore`. Record types: `made`, `stated`, `bound`, `cited`, `actual`, `check-state`, `observed`, `closed`.

A `made` record holds:

| Field | Content |
|---|---|
| `id` | `PRJ-<machine short id>-<n>`, minted by the server, so two machines never mint the same id |
| `madeAt` | Where the clock starts. For an agent's projection it is the server clock at recording. For a person's projection it is the timestamp of their logged message, so a person's estimate recorded later by the agent is still measured from when they said it. |
| `madeBy` | `{kind: 'agent', sessionId?, runId?}` or `{kind: 'person', marker, excerpt}` (section 5) |
| `task` | One line of plain text |
| `taskType` | One of: `spec`, `feature`, `bug-fix`, `port`, `investigation`, `ops`, `review`, `release`, `document`, `other` |
| `milestone` | `{text, check}`. The text cannot be changed after `made`. `check` is one of the forms in section 2. |
| `first` | `{lowHours, highHours, kind: 'elapsed' \| 'net'}`. `elapsed` is wall-clock time to the milestone. `net` leaves out time spent waiting for a person's answer. A point estimate has low = high. |
| `conditions` | Declared by the agent: `{designModel, buildModel, parallelism: {sessions, subagents}, reviewRounds}`. Filled by the server, not the agent: `mode` (`autonomous` when an autonomous run record is active for the topic or run, `job` for a job session, else `interactive`), `framework`, `machine` (machine ids from the registry). Model names are lowercased and must match the pattern `[a-z0-9._/:-]{1,64}`; anything else is stored as `unknown` with a flag saying a declared name was rejected (so "not given" and "did not fit" stay distinct). The pattern is an injection guard for strings that later appear in an agent's context. |
| `group`, `links` | Optional: a group id; `topicId`, `commitmentId`, `workCardId`, `initiativeId`, `repos[]` |
| `supersedes` | The id of a projection this one replaces |

Every stored text field (`task`, milestone `text`, `statedText`, a person's excerpt, a close reason) is capped (500 characters; `statedText` 200, the Work Board's own defaults for item and option text; over the cap the record is refused, nothing is truncated) and passes the credential check the Work Board applies to card text; a live credential refuses the record, as it does for a card. This is the one place this spec refuses anything, and it is the repo's existing credential wall. They are shown on the dashboard (escaped) and are never put in the session-start block, in telemetry or in the prior file.

**Recording is two steps, and the track record is the reply to the first.** `POST /projections` takes the fields above with the agent's first estimate and returns the record together with the calibration read for its bucket (section 4). The agent then calls `POST /projections/:id/stated` with `{lowHours, highHours, statedText}`: what it is actually going to tell the person, which may equal the first estimate. This order is the point: the first estimate is on record before the server shows the correction, so the correction is learned from estimates it did not shape. The first `stated` record wins; a later one, or one posted after the actual, is refused. A `made` record with no `stated` record is treated as stated-equals-first.

### 2. Milestone checks and who wrote the evidence

Every actual carries a `provenance`. Only two provenances feed the correction.

| Check form | Read from | Provenance |
|---|---|---|
| `PR owner/repo#N merged` | GitHub `merged_at`, default branch, repo listed in `links.repos` | `external` |
| `person-confirms` | A Work Board `confirm-done` tap made with presence proof on the linked card, or a logged human-authored message the agent cites (section 5) | `person` |
| `self-report` | The agent posts the time with its evidence | `agent-own` |

`external` and `person` actuals are **measured** and feed the correction. `agent-own` actuals are recorded and shown, and never feed it: a self-report is the agent grading itself. A Work Board tap made with the dashboard PIN is also recorded as `agent-own`, because an agent can hold the PIN; only a presence tap from a person's phone counts as `person`.

**Evidence must come after the estimate.** For a re-estimate chain the clock is the first projection's, and its bindings and citations carry forward, so a milestone that passed between the first estimate and a later re-estimate still counts. An actual whose source time is earlier than that `madeAt` (a PR that had already merged, an older message) is recorded with the label `already-satisfied` and does not feed the correction.

**A merge the agent performs itself still counts as `external`.** The agent often opens and merges its own pull requests. The time is GitHub's, the milestone text is fixed before the work, and the text is shown beside the PR title; that is the control, and `person-confirms` exists for milestones such as "it works" that no merge proves. The response to `POST /projections` says which provenance the chosen check will have, so the agent is steered to a measured form when it writes the milestone.

**Binding a pull request later.** At estimate time the pull request usually does not exist. A milestone may be recorded as `PR <repo> (to be bound) merged`, and a `bound` record later names one or more PR numbers; the list can be amended until the actual is written. With several PRs the actual is the last `merged_at`, the rule the Chief of Staff's evaluator already uses. The milestone text is fixed at `made`; the dashboard shows it beside the bound PRs' titles so a mismatch is visible. A PR bound after it had already merged is labeled `bound-after-merge` and does not feed the correction.

The Chief of Staff's `PR ... merged` done items use the same text. A projection for a Chief of Staff project copies that text as its check; nothing reads the Chief of Staff store. Its `page ... contains` form is not a projection check: a page is evidence the agent can usually write, and fetching agent-supplied URLs from the server is a risk this feature does not need.

### 3. Writing actuals: one reconcile pass

`ProjectionReconciler` (`src/monitoring/ProjectionReconciler.ts`) is the only writer of measured actuals. Every check form is a read of stored state (GitHub, the card store, the attribution runtime), so the reconciler does not depend on catching events: a pass that happened while the server was down, before the feature was enabled, or on another machine is found on the next pass with its original time.

- It runs once an hour, and once at boot and when the feature is turned on. The Chief of Staff's own convention is a check cadence of an hour or more, and the actual's time comes from the source record, so a slower pass delays the write and never changes the number. It runs on the lease holder only: GitHub, the replicated card store and the attribution runtime can all be read from there. It is deterministic reads only (supervision tier 0); no model is called.
- `actual.at` is the source's own time: `merged_at`, the tap's `at`, the human message's timestamp. It is never the time the pass noticed.
- The earliest evidence wins. If a lease move leads two machines to write an actual for the same milestone, the fold takes the earliest `at`.
- **Pending is not unreadable.** A PR that is unbound or still open, and a confirmation nobody has given yet, read `fail` (pending): the projection stays open and, once past its high estimate, overdue. Only a read error (GitHub refuses, the repo is gone, a peer holding the cited message is unreachable) reads `unknown`.
- **Brakes.** A pass makes at most 50 GitHub reads, taking the checks evaluated longest ago first, so more open projections slow the round and never grow the load. A check that reads `fail` or `unknown` doubles its own interval up to one day; a new `bound` or `cited` record resets it. Three passes in a row in which GitHub reads were attempted and every one errored pause GitHub reads for six hours and file one degradation report per outage, marked `internalOnly` (logged, never sent to the operator). The first `unknown` for a check writes a replicated `check-state: unreadable-since` record, so the seven-day count survives restarts and lease moves. A check that has read `unknown` for seven days gets a `check-state: uncheckable` record: the projection is shown as "could not be read since <date>", is re-checked daily, returns with a `check-state: readable` record if a read succeeds, and stays in the overdue list if it is past its high estimate.
- Card reads are in-process, hourly, and one lookup per open projection. The reconciler registers with the self-action controller list like the other background loops; its one self-triggered action is the degradation report, once per outage.

`closed` is written by the owning agent with a reason: `abandoned`, `rescoped` (with `supersedes` on the successor) or `wrong-capture`. Closing never removes a row from the count: every closure is reported in the cohort figures of section 4, split into closed before and closed after the high estimate.

**A re-estimate does not erase the first estimate.** `POST /projections/:id/re-estimate` closes a projection and opens a successor that carries the same milestone text and check; the server copies them, so the agent cannot alter them on this route. When the last projection in such a chain gets a measured actual, the chain is **one row**: the first projection's `madeAt`, first estimate and stated estimate, scored against that actual. Later estimates in the chain are shown on the projection's page and are not pooled. An agent that said "4-6 weeks", saw after a day that it was nearly done and honestly re-estimated "two more hours" is recorded as having been off by the full amount, which is the signal this feature exists to catch.

**A changed milestone is a different thing.** Closing with reason `rescoped` and recording a new projection with a different milestone ends the first one without a score: it is counted in `cohort.scopeReplaced`, and the new projection is scored on its own. A ratio is only ever computed between an estimate and the milestone it was made for.

### 4. The calibration read

The fold computes for each agent-made projection (or re-estimate chain) with a measured actual:

- `elapsedHours` = actual `at` minus `madeAt`.
- Person-wait intervals: on a linked Work Board card, from each `waiting-on` question addressed to a person to that person's next tap **made with presence proof**, overlaps merged, clipped to the window. The server clocks both ends. This is recorded response latency, taken out by convention; it does not claim the agent did nothing meanwhile. An approval is a wait too: from the record that made approval required to the valid `approve` tap with presence proof. A linked card with no questions and no approval required is a measured wait of zero. A question or approval that was answered with a PIN tap, or not answered by the time of the actual, makes person wait `unknown` (and is counted in `excluded.waitUnmeasured`, so an agent cannot quietly drop a slow row this way). A replaced question's interval continues into its successor.
- `netHours` = elapsed minus those intervals. Absence is not a measurement: with no linked card, or the Work Board off, person wait is `unknown` and so is `netHours`. A net result at or below zero is also `unknown`. Such rows are shown with their elapsed time, stay out of the `net` medians, and are counted in `excluded.waitUnmeasured`. An agent that wants a `net` estimate scored asks through a card.
- `pipelineHours` = for the bound PRs, first `created_at` to last `merged_at` (from GitHub), clipped to the window. It is reported beside the result and in the read's typical waits, and is **not** subtracted: agents often open a draft PR when work starts, so PR-open time is not waiting time. A person told "3 hours" can see "took 5 hours, of which the PR was open for 2".
- `ratio` = the hours of the estimate's own kind, divided by the geometric mean of the **first** estimate. `statedRatio` = the same over the stated estimate.

Projections made by a person are scored the same way and shown beside the agent's on the dashboard. They never enter an agent's calibration read or the fleet prior.

Blocker episodes on a linked commitment are shown on the projection's page as "agent-declared waiting" and are not subtracted anywhere: the agent sets their class and their start.

`GET /projections/calibration?taskType=&mode=&buildModel=&kind=` and the reply to `POST /projections` return:

```
{ bucket: {kind, taskType, mode, buildModel},
  matched: 'exact' | 'taskType+mode' | 'taskType' | 'own-history' | 'fleet-prior' | 'none',
  source: 'your own measured history' | 'fleet prior from N installs, not your history',
  n, newestActualAt, oldestActualAt, allTime: {n, ratioMedian},
  ratio:       {median, p25, p75},        // actual / first estimate
  statedRatio: {median, p25, p75},        // actual / stated estimate
  actualHours: {median, p25, p75},        // how long tasks in this bucket actually took
  waits: {personHours: {median, p75}, pipelineHours: {median, p75}},
  overdue: {openCount, worst: [{id, elapsedOverEstimate}]},   // the ten most overdue, as lower bounds; not in the medians
  cohort: {made, completedMeasured, open, overdueOpen, closedBeforeDue, closedAfterDue, scopeReplaced, uncheckable},
  excluded: {agentOwn, alreadySatisfied, boundAfterMerge, waitUnmeasured} }
```

Rules:

- **Medians and quartiles are over completed, measured projections only, and say so.** They are conditional on the work having finished. A projection still open past its high estimate is listed in `overdue` with "at least this much", measured in the estimate's own kind of time: wall-clock for `elapsed`; for `net`, wall-clock minus the person waits recorded so far, and when those cannot be measured the row shows its age and its overdue status reads `unknown`. `cohort` counts everything recorded in the bucket: how many finished, how many are open, how many were closed before and after their high estimate, how many had their milestone replaced. An agent that closes a slow projection before it is due does remove a likely miss from the medians; the cohort line is where that shows, and the wording rule below has the agent say "of N estimates, M finished" when the two differ much.
- **Recent rows, with all-time beside them.** `ratio`, `statedRatio` and `actualHours` are computed over the 20 most recently completed measured rows in the bucket (all of them when there are fewer), and the read also returns `allTime: {n, ratioMedian}`. An agent's speed and habits change with models and practice; if old ten-fold misses stayed in the median for ever, an agent that had already learned would be over-corrected by its own past. Twenty is the stage 2 exit sample; it tunes an advisory number and both figures are always shown.
- **`actualHours` is the anchor that estimates cannot bend.** It is how long this kind of task took, regardless of what anyone guessed.
- **The correction is `ratio`; `statedRatio` is its check.** If stated estimates are landing near 1, the correction is working. If first estimates themselves drift toward 1 over time (the agent has learned its speed, or remembers the last read), `ratio` moves to 1 with them and the correction fades out, which is the right end state. The two-step recording keeps the server from shaping the first estimate; it cannot stop an agent remembering an earlier read in the same session, and the read does not claim to.
- **A read never mixes kinds of time.** `kind` is part of every bucket, in the agent's own history and in the fleet prior; an `elapsed` estimate is never corrected with `net` history or the reverse.
- **Buckets use the declared build model.** Rows are filed and read under the `buildModel` the agent declared, so writing and reading use the same key. Observed models are shown on the row, and a row whose observed models do not include the declared one is marked.
- **Fallback order** is fixed, stays within the kind, and is returned in `matched`: exact bucket, task type and mode, task type, the agent's whole history, the fleet prior (matched on task type, mode and the model family of `buildModel`), none. Parallelism and review rounds are recorded on every row and shown in the view; they are not bucket keys, because each added key divides a small sample again.
- **Sample size is always shown and never thresholded.** With `n: 1` the read says `n: 1`.
- **A fleet prior is never presented as a track record.** `source` says whose numbers they are, and the wording rule below requires the agent to say so.
- **Accuracy is closeness.** Where the view shows an agent's accuracy, it is the median absolute log of `statedRatio`: finishing in half the time and in double the time score the same.

The read is advice. An agent may state an estimate that differs from the corrected figure when it has a reason; both numbers are on record.

**Session start.** The session-start hook prints one fixed block from `GET /projections/session-context`: "Before you give any time estimate, record it with POST /projections; the reply shows how your past estimates of that kind ran. You have N open projections, M past their estimate." Two integers and fixed text; no ratios, so nothing shapes a first estimate before it is recorded, and no task text. It is printed for interactive and autonomous sessions, not job sessions. The fetch is added to both forms of the hook (the inline one from `PostUpdateMigrator.getSessionStartHook()` and the template `src/templates/hooks/session-start.sh`) with a three-second limit, and fails open: on a 503, a timeout or an error it prints nothing.

**How an estimate is worded to a person** (guidance in the awareness entry, not a gate): the time, what it excludes, and the basis in one clause. "About 3 hours, not counting your approval. My last 14 estimates like this took 0.4 times my first guess." With a fleet prior: "based on other Instar agents, not my own history yet". With nothing: "I have no track record for this kind of task yet."

**Closing the loop with the person.** When a projection that was stated to a person gets its actual, the agent's completion message for that work includes one line: estimated, actual, and how much of it was waiting. It rides on a message the agent already sends.

### 5. A person's projection and a person's confirmation

Justin's "24 hours, 48 at most" is a projection and is recorded next to the agent's, on the same milestone, so both are scored by the same actual. To record one, the agent passes the marker of the person's logged message and the excerpt that holds the estimate. The server resolves the marker through the attribution runtime (which already asks the agent's other machines when the message is not local), requires `authorship: human`, and requires the excerpt to be a literal part of that message. A marker that resolves to anything else is refused; an unreachable machine gives a retryable answer and nothing is written, never a refusal. A message that was removed or cannot be found voids the citation with no retry.

A person's confirmation by message ("yes, it works") uses the same path. The agent calls `POST /projections/:id/confirm` with the marker and excerpt, which writes a `cited` record. The reconciler on the lease holder resolves it under the same rules, plus two: the message must be in the projection's `links.topicId` and timestamped at or after `madeAt`. It then writes the `person` actual at the message's own time. Which message counts as a confirmation is the agent's judgment; the excerpt is shown on the dashboard beside the milestone text so a person can see what was taken as their yes. A person never calls a route.

### 6. Catching estimates nobody recorded

One layer, inform-only. A deterministic detector (`src/core/estimate-claim.ts`) finds duration-estimate phrasing about future work ("will take about N hours/days/weeks", "N-M weeks", "ready in N days") in an outbound message. `POST /messaging/preflight` runs it for every sender that goes through preflight (script-class senders skip preflight today), whenever outbound preflight itself is on, and looks up projections recorded for the message's topic in the previous 24 hours. If none has a first or stated range that overlaps the phrase's duration or range, the response carries a note, with the one-line way to record the estimate. A message with no topic gets no note.

The note is **not** an advisory. Today's Telegram reply script refuses to send a message that has any advisory until the agent acknowledges it, and acknowledged advisories count toward an operator Attention item. So the note travels in a new response field, `notes[]`, which never enters the advisory audit, acknowledgement or escalation paths. The reply script sends the message as normal and prints the notes afterwards (and prints them too when an unrelated advisory holds the message). The script template changes by a few lines and reaches existing agents through the existing relay-script update path (`migrateScripts()`), including that path's existing handling of a locally modified script. The message is never held, and this spec adds no source of operator notices.

The Chief of Staff binding guidance gains one line: when a binding has done items and the agent has stated a timeline, record one projection per done item.

### 7. Pooled learning across agents: the fleet prior

Other agents learn from a data file shipped in a normal release, `src/data/projection-fleet-prior.json`: per bucket (`kind`, `taskType`, `mode`, model family), the median `ratio` and the median `actualHours` (each the median of the contributing installs' own medians), a banded sample size (`1-9`, `10-49`, `50+`), and the number of contributing installs. It carries no quartiles, waits or cohort counts; a read answered from the prior returns those fields as `null` and says so in `source`. It contains numbers and category names only. It is the `fleet-prior` step of the fallback order, so a new agent with no history starts from what the fleet measured.

**Who builds it and from what.** The file is built by a script in this repo, `scripts/build-projection-fleet-prior.mjs`, run by the Instar maintainer agent as a release step, and reviewed in the release PR like any other data file. It has two inputs:

1. **The maintainer operator's own agents**, read directly from their ledgers (measured rows only). This is the only data at launch. Buckets from this input are labeled with their install count, and the file's header says "from the maintainer's own agents". Publishing these numbers is authorised by the operator's approval of this spec; no other operator's data is involved.
2. **Other installs, through telemetry**, once any report. A new section in `BaselineSubmission` (its `v` field goes from 1 to 2), sent only when telemetry is at `usage` level **and** `projections.telemetry.enabled` is on (off by default, its own switch, because this is a new kind of data):

```
projections: [{ taskType, mode, modelFamily, kind,
                ratioHistogram: [9 counts],     // projections closed in this submission window only
                actualHoursHistogram: [9 counts] }]
```

   Ratio bin edges: 1/8, 1/4, 1/2, 0.8, 1.25, 2, 4, 8. Hours bin edges: 0.5, 1, 2, 4, 8, 24, 72, 168. `modelFamily` is the model id with its date suffix removed and must match the pattern in section 1. Each submission is keyed by the existing `installationId` and `windowStart`, and a projection belongs to the window in which its measured actual was first written locally; the receiving service must ingest a given install-and-window once, so a retried submission is not counted twice, and a later-revised actual is not re-sent. The 8 edges give 7 inner bins and 2 open outer bins, 9 counts, each bin including its lower edge. The build script rebuilds each install's median from its summed histograms by interpolating on a log scale inside the bin. An install whose median falls in an open outer bin (for ratios under 1/8 or over 8, for hours under 0.5 or over 168) has no number to pool; if that leaves a bucket's pooled median undefined, the bucket is left out of the file with the reason logged in the release PR. The section has an explicit validator that drops any field not named here; the collector has no general allow-list today, so this validator is built with the section and unit-tested. Person-wait figures are not sent: they describe the operator, not the agent.

**Publication rule for other installs' data.** A bucket built from telemetry is published only when at least three installs contributed, the pooled value is the median of per-install medians (one install cannot dominate by volume), and counts are banded. What this protects and what it does not: it stops a lone contributor's numbers from being read straight out of the file; it does not stop two colluding contributors from estimating a third's, a careful reader differencing two releases, or fake installs skewing a bucket (installs are not authenticated; the release PR review and the `source` label are the controls). The values at stake are a ratio histogram for a task type and model family, with no text, names or times, and that residual risk is accepted and stated here.

The build script validates every category string against the closed lists before writing, and the server validates the file again at load, so a submitted string can never reach an agent's context.

### 8. Routes, view, awareness, first rows

- `POST /projections`, `POST /projections/:id/stated`, `POST /projections/:id/bind`, `POST /projections/:id/re-estimate`, `POST /projections/:id/confirm`, `POST /projections/:id/actual` (agent-own only), `POST /projections/:id/close`, `GET /projections`, `GET /projections/:id`, `GET /projections/calibration`, `GET /projections/session-context`. Bearer-authenticated. 503 with a plain reason when the feature is off.
- Dashboard console page "Projections": open projections with time used against the estimate; closed ones with estimate against actual, the measured wait for a person where there is one, and how long the PR was open (shown as overlapping context, not as a slice of the total); per-bucket ratio with spread and `n`; the agent's ratio beside the person's where both exist; overdue and excluded counts. Plain words, no ids on the first screen.
- Agent awareness: one entry file, `src/data/awareness/projection-calibration.md` (the awareness-entry registry), carrying the lookup ("how long will X take / how accurate are my estimates → `GET /projections/calibration`, never from memory"), the trigger ("about to give a time estimate → record it, read the reply, then state it") and the wording rule. The registry rebuilds this for every existing agent on update.
- **First rows.** Two interim rows exist as JSON lines in `.instar/state/projection-ledger.jsonl`: PRJ-0001 on the Windows PC (the Windows app: agent 4-6 weeks, Justin 24-48 hours) and PRJ-0002 on the Mac Studio (this spec). A one-time importer on each machine reads its own file, writes each projection in it as a `made` record with the interim id kept in `links` (so a second run finds it and writes nothing), keeps the original `madeAt` and tags the row `imported` so the view says its start time was not server-written, records interim actuals as `agent-own`, and renames the file with an `.imported` suffix. Justin's projection goes through the marker check in section 5.

## What review removed

Round 1 of review (three model families) found that the first draft measured more than it could defend. Removed, with the reason:

- **An "agent work time" meter from the usage ledger.** Usage rows are written at call end, per machine, and keyed by topic; counting them cannot tell a forty-minute call from a ten-second one, cannot be pooled across machines, and counts unrelated work in the same conversation. Time is now elapsed, person wait and pipeline, all from clocks the agent does not write.
- **Check forms the agent itself satisfies** (`commitment delivered`, `autonomous-run met`) as measured sources, and, in round 2, the `page contains` form with its server-side fetch.
- **In round 4: the Local Verify finish line** (a first passing run on an early head would date a milestone too soon; a merge already implies a pass).
- **In round 3: subtracting pull-request-open time from net time** (a draft PR opened at the start would swallow the whole build), and treating "no approval card linked" as zero wait.
- **Agent-declared blocker time** as a subtraction.
- **The document-seam note and the periodic model sweep** for unrecorded estimates. One inform-only note at the message seam is kept.
- **Ratios in the session-start block**, a per-projection sweep cadence, quiet-hours accounting, and a per-agent ranking.

## Decision points touched

| Decision point | Classification | Floor / arbiter / justification |
|---|---|---|
| Whether a milestone check has passed | invariant; basis: enumerable-domain; evidence: each of the three forms in section 2 reads one recorded fact (`merged_at` present on every bound PR, a presence tap present, a resolved human message present, or the agent's own report) and yields pass, pending or unknown; there is no partial pass to weigh. |
| Whether an actual feeds the correction | invariant; basis: enumerable-domain; evidence: it is a function of recorded facts only: the actual's provenance (one of three values fixed by the form and the tap's proof), whether its source time is before `madeAt`, whether the PR was bound after it merged, and whether the projection was made by an agent. |
| Which pull requests are bound to a milestone | judgment-candidate; floor: the milestone text is fixed at `made` and shown beside the PR titles, a PR bound after merging or merged before `madeAt` is excluded, and a wrong binding moves one row of an advisory read; arbiter: the owning agent; fallback: no binding, the projection stays pending and becomes overdue. |
| Which message counts as a person's confirmation | judgment-candidate; floor: the server requires human authorship, the projection's own topic, a time at or after `madeAt` and a literal excerpt, and shows the excerpt beside the milestone; arbiter: the citing agent; fallback: no `cited` record, no actual. |
| Whether a person's projection is recorded | invariant; basis: enumerable-domain; evidence: the marker resolves to a message with `authorship: human` that literally contains the excerpt, or it does not; without that the agent would be putting an estimate in a person's mouth. |
| Which task type a projection has | judgment-candidate; floor: a closed list of ten values with `other`, and a wrong choice only moves a row between buckets of an advisory read; arbiter: the recording agent; fallback: `other`. |
| Which kind of time and which check form a projection uses | judgment-candidate; floor: the reply to recording states the provenance the chosen check will have and whether a `net` estimate can be scored (a card is linked); a poor choice yields a row that is shown and does not feed the correction; arbiter: the recording agent; fallback: `elapsed` with `self-report`. |
| Whether an outbound sentence is an unrecorded estimate | judgment-candidate; floor: the only action is one note in a separate response field that cannot hold, alter or delay a message and is outside the advisory acknowledgement and escalation paths; default on detector error, missing topic or store unavailability is no note; arbiter: the sending agent, which records the projection or ignores the note; the ladder ends at "no note". |
| What an agent states after the read | judgment-candidate; floor: first and stated estimates are both recorded, the read is advisory, and no route refuses or rewrites an estimate; arbiter: the estimating agent; fallback: with no read available it states its first estimate. |
| Which bucket a read falls back to | invariant; basis: enumerable-domain; evidence: the six-step order in section 4 is fixed, never crosses kinds of time, and the step used is returned in `matched` and `source`. |
| Whether a projection is closed, re-estimated or has its milestone replaced | judgment-candidate; floor: every closure is counted in `cohort` (before due, after due, scope replaced), a re-estimate chain keeps the server-copied milestone and is scored from its first estimate, and a ratio is never computed across different milestones; arbiter: the owning agent, with a required reason; fallback: the projection stays open and is listed. |
| Whether a telemetry-built bucket is published in the fleet prior | judgment-candidate; floor: at least three contributing installs, median of per-install medians, banded counts, category strings validated against closed lists; arbiter: the maintainer agent at release, in a reviewed PR; conservative default: the bucket is left out. A bucket from the maintainer operator's own agents is published under that operator's own authorisation and labeled. |

## Fixed limits

| Limit | Value | Basis |
|---|---|---|
| Reconcile pass | hourly | The Chief of Staff's check convention (`checkCadenceHours` of one or more). It delays the write of an actual and never changes its time, which comes from the source. |
| GitHub reads per pass | 50 | External constraint: the authenticated GitHub REST allowance is 5,000 requests an hour, shared with the merge line and the Chief of Staff; 50 is one percent of it. It is an operating brake: excess checks wait a pass and nothing is dropped. |
| Per-check backoff | doubling to one day | No Unbounded Loops: a check that keeps reading pending or unknown is asked less often; one day bounds the delay before a late pass is written, and the written time is still the source's. |
| GitHub breaker | three all-error passes, six-hour pause | No Unbounded Loops: sustained failure stops the reads; after the pause one pass is tried, so a permanent outage costs at most 50 failed reads every six hours, flat. Logged once per outage. A pass with no reads does not count. |
| `uncheckable` | seven days of read errors | A check that cannot be read (deleted repo, revoked access) is labeled, not dropped: it stays listed, stays overdue if it was, and is re-read daily. A week covers an outage or a permissions fix. Pending checks are never uncheckable. |
| Unrecorded-estimate lookback | 24 hours per topic; the phrase's duration must fall inside a recorded range | Signal tuning; a miss in either direction is one inform-only note or its absence. |
| Model-name pattern | 64 characters, `[a-z0-9._/:-]` | Injection guard for strings that reach an agent's context; a name that does not fit is stored as `unknown` and nothing is refused. |
| Recent-rows window | 20 completed rows | Tuning of an advisory number; all-time is returned beside it. |
| Session-start fetch | 3 seconds | Hook latency at every session start; the same limit as the hook's docs fetch. On timeout nothing is printed. |
| Overdue list in the read | ten worst, plus the full count | Payload size; the count is complete. |
| Telemetry publication | at least 3 installs | Section 7 states what it protects and what it does not; it is a floor under a maintainer's judgment, not a privacy proof. |
| Histogram bins | 9, edges in section 7 | Published interface: fixed bins let windows and installs add. |

None of these limits caps, blocks or throttles what an agent may do or say. The text caps and the credential check in section 1 refuse a record, not a message or an estimate.

## Detectors (P20)

| Symbol read | State it claims | Corroboration | When unmeasurable |
|---|---|---|---|
| `merged_at` on every bound PR | The milestone, defined as that merge, happened then | GitHub is the system of record; the fixed milestone text is shown beside the PR titles; a PR merged before the estimate or bound after merging is excluded | Read error: `unknown`, stays open, labeled after seven days. Not yet merged: pending. |
| Work Board `confirm-done` tap with presence proof | A person confirmed at that time | Written through the card store from a person's phone; a PIN tap is not counted | No tap: pending |
| Cited human-authored message | A person said so at that time | Authorship comes from the message layer; topic, time and literal excerpt are checked by the server; whether the words amount to a yes is the agent's judgment, shown for a person to see | Unresolvable: `unknown`, retried |
| `waiting-on` question to a person, to that person's presence tap, on a linked card | A question to a person was outstanding for that interval (response latency; not a claim that work stopped) | Both times are server-written; a presence tap comes from the person's phone | No linked card, Work Board off, a PIN tap or no answer: `unknown`; net time `unknown` |
| Duration phrase in an outbound message | The agent stated an estimate | The agent's own reading of the note | No note |
| A bucket's ratio | How estimates of this kind and kind of time have run, for those that finished | Returned with `n`, spread, dates, `matched`, `source`, the cohort counts and the overdue list; never a bare number | `matched: 'none'` |

Both directions: a milestone can be truly done while its symbol is absent (work finished, PR waiting in the line). That gap shows up in pipeline time and is why milestones are checks. A symbol can be present while the intent is unmet (a small PR bound to a large milestone); the fixed text beside the PR title is the control, and `person-confirms` exists for milestones that no merge proves.

## Multi-machine posture

`unified`. `ProjectionStore` is one replicated store on the path the Work Board and Chief of Staff stores use; ids carry the machine id. Everything a read needs is a replicated record, including `check-state` (unreadable-since, uncheckable, readable), so any machine and any new lease holder derives the same view. The reconciler runs on the lease holder (a machine that loses the lease stops and the next holder's pass picks up; backoff timers are in memory and restart at the shortest interval). `observed` records are written per machine: when a machine sees (locally or by replication) an actual for a projection that has no `observed` record from itself, it scans its own usage rows (`machine_id` equal to itself) for the projection's `runId` or `sessionId`, including subagents by `parent_session_id`, between `madeAt` and the actual, and writes one record with its models, frameworks and count of distinct sessions and subagents; the fold merges them. One scan per machine per projection. A projection recorded with neither id gets no observed record and its conditions read "declared only". Reads are served from the local replica on any machine. The session-start line is served locally. There is no machine-local surface.

## Migration and rollout

- Flag `projections.enabled`, dev-gated (live on development agents, dark on the fleet). `projections.advisory.enabled` follows it unless set. `projections.telemetry.enabled` is off everywhere by default.
- `migrateConfig()` adds the defaults. The awareness entry reaches existing agents through the registry rebuild. The session-start hook is always overwritten.
- **What an agent gets while neighbouring features are dark.** The Work Board, the usage ledger and the attribution runtime are themselves dev-gated today. Without the Work Board, person wait and net time read `unknown` and `person-confirms` works by cited message only. The unrecorded-estimate note reaches replies sent through the Telegram reply script, the only caller of preflight today. Without attribution, a person's projection and a cited confirmation cannot be recorded. Without the usage ledger there are no `observed` records and conditions read "declared only". Elapsed time, pipeline time, the PR check and the elapsed calibration read need none of them.
- Backup and restore: the store is part of replicated state and is covered by the existing state backup.
- Rollback: turn the flag off. Routes return 503, the hook prints nothing, the reconciler does not run. Records stay on disk; when the flag returns the first pass reconciles everything that happened meanwhile, with original times.

## Maturation plan

Three stages, each its own PR, each useful alone:

1. **Ledger and actuals.** Store, routes, checks, reconciler, importer, wait split, console page. Exit: the Windows app projections (agent's and Justin's) and this spec's projection show estimate against actual from measured sources.
2. **Calibration and the fleet prior.** The read as the reply to recording, the session-start line, the awareness entry, the unrecorded-estimate note, and the first prior file built from the maintainer operator's agents. Exit: twenty measured projections on one agent with `statedRatio` shown beside `ratio`; a second agent reading the prior.
3. **Other installs.** The telemetry section and its validator, and telemetry as the second input to the build script. Exit: one bucket from three installs.

- **test-agent-live:** a throwaway agent with a scratch repository and a team owner. Proves through the real routes and the dashboard page: record, read as the reply, state, bind a PR, a merge found by the reconcile pass with GitHub's time (including one merged while the server was stopped), a person's confirmation by presence tap and by cited message, a PIN tap not counted, a re-estimate chain scored from its first estimate, a replaced milestone unscored, an overdue row, the note printed after a real Telegram send on a demo channel with no advisory and no operator notice.
- **dev-agent-live:** Echo records every estimate it gives for two weeks; the Windows app projections (the agent's and Justin's) and this spec's own projection are the first rows. Luna runs the same build for the second week.
- **fleet:** delivered dark by the migration; the fleet default changes only after the graduation record below and the operator's reading of it. The fleet prior file ships in releases from stage 2 and is read only where the feature is on.
- **graduation criterion:** on one development agent, twenty completed projections with measured actuals; the median absolute log of `statedRatio` over the second ten is lower than over the first ten; the share of estimates given without a record (notes raised) is reported and falling; zero messages held and zero operator notices caused by this feature; zero operator-found defects on the dashboard page's first screen. Fewer than twenty rows writes `incomplete`, never a pass.
- **dark-window:** 14 days dark on the fleet after dev-agent graduation.
- **ladder:** projections.calibration

Review date for the standard: two weeks after stage 2 ships, on the maturation board, measured by the median absolute log of `statedRatio` before and after. Stage 3 needs submissions read out of the telemetry service into the build script; that work, including the service's once-per-install-and-window ingest, is owned by the maintainer agent and is tracked as a commitment opened when this spec is approved.

## Tests

- Unit: the fold ( geometric-mean denominator; overlapping person waits merged; net `unknown` with no linked card, with the Work Board off, and at or below zero; pipeline time never subtracted; kinds never mixed; a re-estimate chain scored once from its first estimate; a replaced milestone unscored and counted; earliest evidence wins when two machines wrote an actual; evidence dated between a chain's first estimate and a later re-estimate still counts; overdue computed in the estimate's own kind; a PIN-ended or unanswered question makes net `unknown`; the recent-rows window; cohort counts for closures before and after due; overdue rows listed and not in the medians; provenance, already-satisfied and bound-after-merge exclusion; person-made rows kept out of agent calibration; fallback order and `source`); the detector on both sides of each phrase boundary; the telemetry validator dropping unknown fields; the publication rule; importer run twice.
- Integration: every route with the flag on and off; `POST /projections` returns the read, `stated` follows, a second `stated` is refused; a human-authorship marker with a literal excerpt is accepted, an agent-authored one and a non-literal excerpt refused; preflight returns the note in `notes[]`, the reply script sends without an acknowledgement, and no advisory or Attention item results; the breaker's report is not sent to the operator.
- E2E: production init path, feature alive (200, not 503) with the flag on; the reconciler writes an actual for a PR merged while the server was stopped, with `merged_at` as its time; a `check-state` record written on one machine is read on another; wiring test that the reconciler's readers are real.

## Frontloaded Decisions

- The clock starts when the estimate is recorded. Time before work begins is real time to the person who was told the estimate.
- One projection, one milestone, one estimate. Plans are groups.
- Recording is two steps; the read is the reply to the first. The first `stated` wins.
- Range estimates are scored against their geometric mean.
- Two kinds of time, `elapsed` and `net`, never mixed in a read or in the prior.
- Net time is elapsed minus recorded person waits (card question to the person's tap); it is `unknown` when there is no linked card. Pipeline time (PR open to merge) is reported and never subtracted.
- Three finish-line forms: PR merged, a person confirms, self-report. No page check and no Local Verify check.
- Only `external` and `person` actuals dated after the estimate feed the correction. A PIN tap, a self-report, a commitment's own delivery and blocker classes do not.
- A person's projection is clocked from their message; buckets use the declared build model; the read uses the 20 most recent completed rows.
- A re-estimate keeps the milestone and the chain is one row scored from its first estimate. A replaced milestone is unscored and counted.
- The unrecorded-estimate note travels in `notes[]`, outside the advisory paths, and is printed after the send.
- Medians cover completed measured rows and say so; cohort counts and the overdue list sit beside them.
- Only agent-made projections feed an agent's read and the fleet prior. A person's are shown beside them.
- No work-time meter. No minimum sample size; `n`, dates and source are always shown.
- Bucket keys are kind, task type, mode and build model. Other conditions are recorded and shown.
- Nothing blocks, holds or rewrites a message or an estimate, and nothing here sends an operator notice.
- The fleet prior is a release data file built by the maintainer agent; its first version comes from the maintainer operator's own agents under that operator's approval of this spec.
- Telemetry for projections has its own switch, off by default, and sends no person-wait data.
- The task type list is closed at ten values.
- Reconcile numbers are those in "Fixed limits".

## Left behind

Review stopped at round 5, the cap. Recorded here and not iterated on.

**Accepted at the cap (design-class, none about safety, security or data loss):**

- *A milestone's finish time can depend on when its PR list was completed.* If PR A merges and PR B is bound afterwards, a reconcile pass between the two closes the milestone at A. Accepted: the agent binds the full set before the first merge when it matters, the `bound` history is on the row, and the effect is one row's time in an advisory read. Queue: stage 1 build notes.
- *Five rule choices from the final round were written into the text and not re-read by reviewers:* approvals count as person waits; a person's clock starts at their message; buckets use the declared build model; the `observed` scan trigger; fleet buckets with an out-of-range median are left out. Each is a single rule with a unit test named in "Tests"; the stage 1 and 2 build PRs carry them through code review.

**Precision items (worth doing in the build, no design change):**

- The unrecorded-estimate note reaches only replies that go through preflight (the Telegram reply script today). Slack and app replies and plan documents, where the original 4-6 week figure appeared, get no note. Queue: follow-up after stage 2, with the awareness entry as the interim control.
- A minimum excerpt length for a cited confirmation, or show the whole message beside the milestone.
- A PIN tap followed by a presence tap on the same question: the first answering tap decides.
- Validate telemetry `modelFamily` against a list of known families in the build script, not only the pattern.
- Gate the importer with a one-time marker and accept only the two named interim ids.
- Serial marker resolution with a per-pass cap alongside the GitHub budget.
- A decision-table row for "what hour range a person's words amount to" (arbiter: the citing agent; floor: the literal excerpt is shown).
- The dashboard flags an abandoned projection followed by a new one for the same topic and task type.
- Brief definitions on first use for "presence proof", "supervision tier 0" and "P20".
- The constitution check's remaining advisory flags (exact numbers for the read budget, pause, caps and pattern; capture resting on the agent's call; a merge standing for the milestone; an unreachable peer reading unknown; the credential refusal) were each judged by the final-round reviewer as wording-level or not applicable, with reasons in the convergence report.

## Open questions

*(none)*
