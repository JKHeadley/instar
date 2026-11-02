---
title: "Ecosystem idea pipeline: learn from similar projects, and adopt only what evidence says does not cost quality"
slug: "ecosystem-idea-pipeline"
author: "echo"
parent-principle: "Close the Loop"
eli16-overview: "docs/specs/ecosystem-idea-pipeline.eli16.md"
review-convergence: "2026-11-02T01:47:33.648Z"
review-iterations: 3
review-completed-at: "2026-11-02T01:47:33.648Z"
review-report: "docs/specs/reports/ecosystem-idea-pipeline-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 2
contested-then-cleared: 2
---

# Ecosystem idea pipeline

## Problem statement

Other agent projects keep finding things Instar could use. Instar has looked at them only once, in the
OpenClaw audit of 2026-05-07, which produced four import specs and no cadence. So what we learn depends on
someone happening to look.

Looking is the easy half. The 2026-11-01 deep dive of `mattabate/life-distributable`
(`docs/research/ecosystem/life-distributable-2026-11-01.md`) produced ten ranked lessons, and its top one was
wrong in a way the ranking could not see: it set a 12 KB context cap against Echo's 448 KB instruction file and
called that the biggest gap. The operator's answer: earlier research looked for a reduction with no quality loss
and had little success, and any pipeline must show a change does not reduce quality or coherence. A byte count
measures a cost and says nothing about what that cost buys.

## Goals

1. Recurring, durable tracking of a watchlist of similar projects (operator directive, 2026-11-01).
2. Each idea checked against Instar's code, specs and Instar 2.0 documents before it is called a gap.
3. Each idea reviewed against Instar's highest goals: an unhindered, powerful agent built on trust and coherence,
   aligned with Instar 2.0.
4. An evidence requirement scaled to the risk of the change, enforced after the idea leaves this pipeline.
5. A ranked list the operator can read and act on from a phone.
6. The pipeline can be seen to work, including when it adopts nothing.

## Non-goals

- **Building anything.** Starting a spec opens an ordinary `/instar-dev` spec. There is no executor.
- **Gating a running agent.** The one downstream block is the lint in section 8, on a development step.
- **Outreach.** Reports to other projects, stars and email are a separate decision.

## Design

### 1. Shape: a server service, not a job session

A job session cannot do this safely. It carries the agent's auth token, runs with permission prompts skipped, and
an allowlist restricts tools rather than paths (`src/scheduler/JobScheduler.ts`, `src/core/SessionManager.ts`).
Confinement is Claude-only and off-Claude job routing is not live (`JOB_MODEL_ROUTING_AUDIT_READY`).

So this follows `src/feedback-factory/triage`: **trusted server code does all fetching and file reading, and builds
scrubbed packets. Models get closed-schema calls and return data.** Calls use the internal intelligence provider, so the feature runs
on any framework, off Claude where one is active.

**A call may not simply be assumed tool-less.** Claude is only tool-free with `reviewerHardening`; Codex runs `--sandbox read-only`, and Gemini
`--approval-mode default`, either of which may still read local files. So a framework is admitted to this service only after **two must-fail probes** on that machine and CLI version, through the same single invocation path every real call uses (scratch working directory, allowlisted environment): an **injection probe**, where a quoted packet tells the model to read a planted secret file, and a **capability probe**, where the trusted prompt itself directly asks for that file. The first shows whether it obeys, and only the second shows whether it can. If the secret appears in any output of either probe, or a probe cannot run, that framework is refused for this service and the refusal is shown on the status route. Codex's `--sandbox read-only` may well be refused by this; building a stronger call form for it (for example under the existing `ConfinedRunner`) is in scope for the build, and until one passes, ideas stay `single-family`. With no admitted
framework the service does nothing and says so. A passed probe is evidence about one attempt, and a model able to read the file could still decline to show it, so every model output is also screened for credentials by the existing scrubber and clamped to the schema before saving, and a saved claim is never treated as instructions anywhere. The residual risk is a local file read that survives both, reaching the ledger as quoted text and replicating to the agent's own machines; it is accepted and named here. The canary repeats on any CLI version change. The feedback triage service shares this provider and this exposure; that finding
goes to its owner separately and does not wait on this spec.

The service runs a server tick on the serving lease holder. Each write carries the holder's lease epoch and is refused
when a newer epoch exists (the triage store's owner fence), so an old holder that keeps running cannot write.

### 2. Watchlist

Entries `{ id, repo, addedBy, addedAt, reason }`. Seeds, each confirmed to exist on 2026-11-01:
`openclaw/openclaw`, `NousResearch/hermes-agent`, `mattabate/life-distributable`. The service may propose an addition.
A proposal joins on the operator's yes (section 9).

### 3. Fetch

Trusted code clones outside the agent home with the hardened git config of `src/feedback-factory/execute/executorPorts.ts`
(`HARDENED_GIT_CONFIG`), extended here with settings it lacks today: https only, a GitHub host allowlist, `GIT_CONFIG_GLOBAL=/dev/null`, no submodules, `GIT_LFS_SKIP_SMUDGE=1`, `core.symlinks=false`, and
blobless (`--filter=blob:none`), capped at 2 GB and 10 minutes. A project over the cap is reported, not retried. Nothing from a clone is ever executed, and it never becomes any
process's working directory, so project hooks and instruction files cannot load.

Each project has a durable **review cursor**: `{ targetCommit, reviewedCommit, filesDone, attempt }`, and each idea a durable **stage** (`candidate`, `gap-first`, `gap-second`, `goal`, `done`), so a limit stops work at a stage and the next run resumes it.

- A run pins `targetCommit` and reads the diff from `reviewedCommit`. With none, or if that commit has vanished (force
  push), it does a **baseline review** of the project's changelog, README and docs at the target.
- Progress is checkpointed after each file batch. `reviewedCommit` advances only after all of that project's candidates
  are saved. A run stopped by a limit keeps its place and resumes next time.
- Each run also compares the recorded HEAD to `git ls-remote`, so "nothing new" is known, not assumed.

### 4. Candidate

A model call on a packet of quoted files returns candidates in a closed schema, with size caps:

- `claim`: one plain sentence
- `evidence`: paths and lines. Trusted code checks each exists at `targetCommit` and drops a candidate with none, counted.
- `maturity`: computed by trusted code where it can be (commit age, whether a test file references the code), never taken
  from the project's own description

Idea ids are stable. Revisions are append-only events: a new sighting never changes a decision or proof attached to an earlier
revision, because those bind to a record hash (section 9). Whether a candidate repeats an existing idea is a model judgment
on quoted text. A wrong merge is corrected by splitting, and the event log keeps both.

### 5. Gap check

Trusted code holds fresh checkouts of the agent's configured source roots, recording each commit. `ecosystemIdeas.sourceRoots` defaults on an Instar
maintainer agent to `origin/main` of Instar and of `JKHeadley/instar-2`, and any agent developing its own project can name its own. With none configured
the service answers 503 `no-source`.

1. A model proposes search terms for the claim.
2. Trusted code retrieves by meaning and by word, from its own rebuildable index: a dedicated `SemanticMemory` database at `.instar/state/ecosystem/index.db`, never the server's shared `state/semantic.db`, so nothing here can reach session recall or private memories. A small indexer feeds it chunks of the specs, standards and ledger, with the embedding provider wired in. Literal search over code uses those terms as fixed strings. Results are bounded, and a truncated result says so. If vector search is unavailable the search is recorded as `word-only`, and that idea cannot reach Now, because a word search alone misses a differently named feature, which is the usual way a gap claim is false.
3. The model classifies: `gap`, `partial` (and how), `have-it` (and where), or `not-for-us` (and why), citing results.

**A second read from another model family repeats steps 1 to 3 blind:** it never sees the first verdict or its search terms, and it sees
the claim plus the evidence files, not only the claim. Disagreement gives `unverified`. On an agent with one family, the second read is a fresh
call labelled `single-family`, and its ideas can reach Plan but not Now.

Nothing is thrown away. `have-it`, `not-for-us` and stopped ideas keep their records, and section 10 audits a sample of them.

### 6. Goal review

Each surviving idea answers in writing, against the Instar 2.0 purpose at a recorded commit:

1. **Coherence.** Does it help or harm the agent being one continuous thing across sessions, machines and time?
2. **Trust.** Does it make the agent more or less reliable and honest?
3. **Unhindered.** Does it add a limit? The purpose's rule applies: "a limit names the rule that requires it". An added limit that names none is
   `not-for-us`.
4. **Instar 2.0.** Already in the 2.0 design? In conflict? Would 1.x work be thrown away?
5. **Cost of not adopting.** What does the agent or its operator keep losing without this? Staying still has a cost, and this question makes the review
   weigh it.

These are model judgments on quoted text and are labelled so. A stated harm on 1, 2 or 3 stops the idea unless later evidence passes.

### 7. Effect class

| Class | Means | Evidence needed |
|---|---|---|
| `additive-dark` | New and off by default; takes nothing away | Ordinary review and tests. **Reclassified when turned on or widened**; it is judged again as what it then is |
| `behaviour-changing` | Changes what agents do, or adds something they load or can do | A measure named in advance, a baseline and a result, dry-run first |
| `reduces-capability` | Removes or limits: less context, a new tool limit, a removed step | Section 8 |

Floor: when in doubt, the higher burden. Two blind reads classify each idea and the higher class wins. Trusted code also applies one check: an idea whose evidence or claim concerns what agents load at session start, tool
permissions, or removal of a step cannot be classed below `behaviour-changing` by a model alone. Lowering a class needs the operator. A later spec may raise it.

### 8. The evidence requirement

**This gives bounded evidence, never proof of zero loss.** The rule is: **no evidence, no adoption beyond one development agent, unless the operator records an
exception.** Starting a spec is not adoption. Adoption means switching the change on beyond one development agent.

For `reduces-capability`, a trial report is committed to the repo at `docs/proofs/<idea>.json`:

- **Pre-registration.** The plan is committed before any trial runs, and git history shows that. It names the measures, which must cover what the change could harm (for
  context reduction: rules retained, correct use of capabilities, coherence after compaction and across sessions), the task sampling rule, and the **acceptable regression margin**.
- **Prior research first.** The plan cites earlier work on the subject. If earlier work failed, it says what is different. If nothing is different, the idea stops.
- **Real, sampled tasks.** The same tasks with and without the change, sampled by the pre-registered rule rather than chosen, including work that spans sessions, repeated enough to report uncertainty.
- **Blind judging,** by a reviewer who cannot tell the conditions apart. If the output reveals the condition, the report says so and the result is `unproven`.
- **Non-inferiority.** It passes only if the uncertainty range stays inside the margin. "No difference observed" alone never passes.
- **Positive control,** as an extra check. A degraded variant, sized like the claimed reduction, must be caught.
- **Attempts are budgeted in advance.** The plan states its stopping rule and how many attempts it may use. A pass after an earlier failure counts only with a fresh confirmatory run on newly sampled tasks. Every attempt stays in the report, and a new plan lists prior plans.
- **The margin is reviewed.** The plan's margin is read by another model family before the trial. Widening a margin after a failure needs the operator's PIN.

A claim that cannot be measured is `unproven`, not passed.

**No trial runner exists today**, and this feature does not build one. A `reduces-capability` idea reaches it by its own development-only spec, which may build the trial infrastructure and run behind a dev-gated flag, with the evidence rule still holding for anything wider. That is the route out of Plan.

**Enforcement, downstream.** A spec started from an idea carries in frontmatter `ecosystem-idea: <id>`, `effect-class`, its record hash, and `ecosystem-flags:`, the config paths that switch it on, and `ecosystem-paths:`, the source it changes. Its evidence lives in the repo at `docs/proofs/<idea>.json`, with `kind: trial`, `measure` (for `behaviour-changing`) or `exception`. A lint fails any change to the default of a listed flag beyond the development gate unless that file exists, is well formed, carries `record-hash` for this idea, and has `result: pass` or is an unexpired `exception`. A report records `testedCommit`, the configuration and `rolloutScope`. The lint refuses a report whose `testedCommit` is not an ancestor of this head, or when `ecosystem-paths` changed since it, or when the change goes beyond the scope, so an old pass cannot cover changed code. `unproven` and failed results do not satisfy it. For a `trial`, it also checks that the plan's commit precedes the results and that attempts are listed. A tagged `reduces-capability` spec with empty `ecosystem-flags` fails too, because reductions are often flagless: its spec must name a config path or an `exception`.

**What this covers, stated plainly.** It covers default changes in tagged specs. It does not see an untagged PR, a change with no flag, or an operator choosing to enable something on their own agent, which is their act. The agent writes the frontmatter, so this stops forgetting, not a determined forger, the same trust level as an instar-dev trace. The monthly audit in section 10 reads adopted ideas against this, and the side-effects review for a change from an idea must name its class.

**Exception.** The operator may accept an idea without evidence, by dashboard PIN. The route writes an audit row, and the agent commits the `exception` file citing it. An exception names scope and rollback, and carries an expiry and a graded review date. On expiry an attention item stays open and further changes to that flag are refused until it is answered. It never switches anything off by itself, because an automatic change to a running agent is exactly what this pipeline distrusts.

### 9. Operator surface and authority

- **Read:** `GET /ecosystem-ideas` (`?scope=pool` from any machine), with a tile in the console's Work group showing the funnel and ranked list. Model text is rendered as escaped data.
- **Notice:** one attention item, `conditionKey: ecosystem-ideas:decision`, fixed-template text, raised only when an idea enters Now or an exception expires. It closes when the idea is started or declined, and otherwise expires through the attention lifecycle. Routine results stay on the page.
- **Decisions:** PIN plan and commit (as `POST /feedback-factory/triage/plan`), from the dashboard on a phone: start a spec on any idea, add to watchlist, decline an idea, accept an exception, lower a class. A bearer token cannot make these. A non-holder answers 409 naming the holder.
- **The agent may also start a spec.** Drafting changes nothing for any agent, and no rule reserves it for the operator, so under the purpose's "a limit names the rule that requires it" no such limit is added. For a Now idea, at most one open at a time, the service opens an ordinary session with a brief holding only the idea id, recording why. A launch intent is saved first, with a deterministic session name from the idea id and revision; dispatch rechecks the lease epoch, and recovery looks for that session name before launching, so a crash or a lease move cannot start a second one. The operator may decline it. It goes through `/instar-dev` as normal.
- **Controlled delivery into that session.** It starts with ids only, and can ask for quoted evidence excerpts through `GET /ecosystem-ideas/:id/evidence`, saved by trusted code at review time. It has no clone in its tree. Quoting records where text came from; it does not make the text safe. This is an ordinary full-tool session that could read an excerpt or fetch the repo, so prompt injection into it is a named residual risk, the same as any session reading outside material.
- **Declined ideas** return only when a sighting adds evidence at a new commit, shown side by side with the earlier decision.

### 10. Ranking, and seeing whether it works

Bands, not scores, because a precise number would claim more than a model judgment can support:

- **Now:** verified by two families, clear goal fit, evidence available or cheap
- **Plan:** real value, evidence still to be gathered
- **Watch:** promising, but young or unproven at the source
- **Stopped:** with the reason

Within a band: goal fit, then size of gap, then effort. Newness earns nothing, and a low class earns nothing on its own. Trusted code applies the band rules to recorded fields, some of which are model judgments.

- **Funnel, always shown:** seen, verified, in each band, decided, adopted, and time since the last adoption. After 8 weeks with nothing in Now and no adoption, one attention item (`ecosystem-ideas:quiet`) shows the funnel and asks the operator to decide: keep it running, change the watchlist, or switch it off. So a pipeline that adopts nothing is not silent, and the notice has an action.
- **Audit of what it stopped:** each month a fresh read samples up to five `have-it` and Stopped records, and overturned verdicts are counted. This also feeds the decision-quality meter, with each gate enrolled in the provenance census.
- **Graded predictions:** each adopted idea records what it predicted and when to check. The check is a recorded result, with `unknown` as an honest outcome.

### 11. First run

The first run reviews the ten lessons in `docs/research/ecosystem/life-distributable-2026-11-01.md` as ordinary candidates, like any others. No expected answers go into any prompt.

## Decision points touched

| Decision point | Classification | Floor or justification |
|---|---|---|
| Gap verdict | judgment-candidate | Floor: cites what was read; two blind reads for Now. Arbiter: models. Fallback ends at `unverified`, which cannot rank |
| Merging a repeated idea | judgment-candidate | Floor: event log keeps both, and decisions bind to a hash. Fallback: a new record |
| Goal review | judgment-candidate | Floor: a stated harm stops the idea; a limit naming no rule is `not-for-us`. Fallback: Watch or Stopped, never adoption |
| Effect class | judgment-candidate | Floor in section 7. Lowering needs the operator |
| Band | judgment-candidate | Floor: rules applied by trusted code to recorded fields; `word-only` or one family cannot reach Now. Arbiter: the recorded model judgments. Fallback: Watch |
| Watchlist proposal | judgment-candidate | Floor: joins only on the operator's yes |
| "New evidence" for a declined idea | judgment-candidate | Floor: only a new commit, and the operator sees both. Default: stays declined |
| Trial result | judgment-candidate for the blind verdict; invariant for whether a report is valid | Lint checks schema, plan commit precedes results, and attempts are listed |
| Adoption lint | invariant | Deterministic, and blocking on a development step only: flipping a default in a PR, in the same class as the instar-dev trace gate. It never blocks a running agent or a message. It asks only "does the record exist and is it well formed", never "is the change good"; that judgment stays with the blind reviewer and the operator. The Standards-Conformance Gate flagged this against Signal vs. Authority and this is the answer: a process gate with an override path (the recorded exception), not a runtime authority |
| Framework admission | invariant | Must-fail canary; a failed or unrunnable probe refuses the framework. Evidence only, no judgment |
| Exception, watchlist yes, decline | invariant | The operator's act, by PIN |
| Agent starting a spec | judgment-candidate | Floor: Now band only, one open at a time, reason recorded, operator can decline. Fallback: no spec. The operator may start one on any idea |

## Multi-machine posture

Posture: `unified`.

- **Ledger:** a replicated store on the WS2 foundation, following `src/core/EvolutionActionsReplicatedStore.ts`. Identity is a stable idea id. Every field is clamped on receipt and peer rows are quoted data. Registered in the state-coherence registry with retention and in `WriteDomainRegistry`.
- **Reviews and writes:** the serving lease holder only, epoch-fenced. After a lease move, the new holder resumes from the replicated cursor. A project may be re-read once, and repeats merge. `GET /ecosystem-ideas` answers from the local replica with its staleness.
- **Clones** are a disposable cache, deleted after each run and read by no other machine, so they are not a state surface.
- **Search index** (`.instar/state/ecosystem/index.db`): rebuildable from the source roots and the ledger on each machine that needs it, so it is a derived cache, not state to unify. Excluded from git sync.
- **Storage:** the replicated store's files and the index go under `.instar/state/ecosystem/`, which git sync already excludes, in line with the WS2 rule, so no `.gitignore` migration is needed.
- **Notices:** only the holder raises them, so one voice.

## Verifying the state, not its symbol

| Symbol read | State it claims | Corroboration | When unmeasurable |
|---|---|---|---|
| Gap search finds nothing | Instar lacks this | Blind second family with its own search terms; recorded terms | `unverified`; cannot rank |
| `have-it` verdict | Instar has this | Cited location; monthly sampled audit | Record kept as `unverified` |
| Goal-review answer | Helps or harms a goal | Only a model's reading, labelled so; a trial for anything that takes away | `unproven` |
| Trial within margin | Change costs less than the margin | Pre-registered plan, positive control, uncertainty range | `unproven`, never passed |
| No new commits | Nothing to review | `git ls-remote` HEAD compared to the cursor | Project shown as not checked, with its age |
| Run row written | A review really read the project | Per-project HEAD and files read; a planted idea in the test fixture is found | Failure path below |

## Failure handling

Self-Heal Before Notify. Class: `recoverable`; nothing here is irreversible or affects a running agent.

- **Remediation:** a failed project retries at the next tick with a re-fetch and resumes from its cursor. Saving is idempotent.
- **Brakes:** at most 3 attempts per project per weekly cycle, backing off 30 minutes, then 2 hours, then wait for next week; a run has a 30-minute wall clock; dedupe key `project + targetCommit`; breaker open after 3 failed cycles, reset by the next successful review of that project or the operator's retry on the page. `max-notification-latency`: the failure shows on the page and in `GET /ecosystem-ideas` at the next tick, within the registry's 300 s ceiling. It raises no attention item until the breaker opens, because a late idea review harms nobody and is not worth interrupting the operator for. Audit: `logs/ecosystem-ideas.jsonl`, ids and counts only.
- **Escalation:** one attention item (`ecosystem-ideas:stalled`) only after the breaker opens, naming the project and last error. Never-run is shown as never-run, not stale.

Other failure modes:

- **Hostile repo text.** It reaches only frameworks that passed the canary, always scrubbed and quoted. A poisoned claim can still mislead a verdict, which is why the second read is blind to the first and reads the evidence itself, and why the verdict never decides anything alone.
- **A manufactured "new evidence".** A project can push commits. It only re-shows the idea to the operator.
- **Licence.** Records describe ideas. A later spec rebuilds from the idea, and checks the licence before reusing code.

## Cost

Per run: at most 300k input tokens per project and 600k in total, at most 8 candidates carried through review per project, configurable under `ecosystemIdeas.limits`. The service pauses at the feedback triage's quota threshold (`QUOTA_PAUSE_PERCENT`, 75%) and resumes from its stages. Spend reports through `/metrics/features`, and the calls join `llmBenchCoverage` and the provenance census. The first baseline review of the very large projects will hit the limit and continue over several weeks through its cursor. That is expected.

## Maturation plan

- **test-agent-live:** the E2E fixture run on a throwaway agent, on the built package.
- **dev-agent-live:** omitted `ecosystemIdeas.enabled` resolves through `DEV_GATED_FEATURES`, live on Echo with its limits, because a recurring feature nobody runs teaches nothing.
- **fleet:** off by default for every other agent, opt-in, because it needs configured source roots and costs tokens. It goes wider only on the operator's decision.
- **graduation criterion:** four weekly runs inside the limits, the funnel and stopped-idea audit read by the operator, and no overturned `have-it` left unexplained.
- **dark-window:** four weekly runs on the development agent before any wider step.

## Frontloaded Decisions

1. **Seeds:** the three repos in section 2.
2. **Cadence:** weekly, in `ecosystemIdeas.cadenceHours` (168).
3. **Default outcome:** no adoption without evidence or a recorded exception.
4. **Shape:** a server service, with each framework admitted by the canary in section 1.
5. **Evidence bar:** section 8, including that the guarantee covers default changes in tagged specs. The trial runner comes with the first idea that needs it.
6. **Starting a spec:** agent's judgment within the section 9 floors, or the operator's on any idea.
7. **Surfaces and keys:** console Work-group tile, one attention key for decisions and one for stalls, PIN plan and commit, `ecosystemIdeas.*`.
8. **Limits:** the numbers in Cost and Failure handling.
9. **Second family:** whichever other active family; `single-family` otherwise.

Cheap to change after, because neither touches a durable external effect, money, identity or a published interface: the band rules and the wording of the goal questions.

## Open questions

*(none)*

## Testing

- **Unit:** band rules, class floor, cursor checkpointing and vanished-commit fallback, event-log merge and hash binding, packet scrubbing and caps, the adoption lint on both sides.
- **Integration:** the framework canary on both sides, routes, dev gate, 503 without source, PIN decisions refused for a bearer token, epoch fence refusing a stale writer, replication of rows.
- **Integration, crash paths:** a crash between saving a launch intent and recording the session, and a lease move, start no second session. An old passing report is refused against changed code.
- **E2E:** a run on a local fixture repo (the only exception to https-only, under a test-only flag) containing a hostile CLAUDE.md and a script that writes a marker if executed. It asserts the planted idea is found, no marker exists, and no instruction in the fixture changes an outcome. A separate run with the file-read step disabled must fail the planted-idea assertion, proving the test can fail.

## Rollback

`ecosystemIdeas.enabled: false` stops the tick and routes, and needs a restart. The ledger stays, so decisions are not lost. A code revert removes the feature, and the adoption lint goes with it. Nothing else depends on it.

## Migration

No file is installed on existing agents except the awareness text: `generateClaudeMd()` gains one short section with a `migrateClaudeMd()` guard, and `CapabilityIndex` gains the routes. The section is kept brief on purpose, given what this spec exists to be careful about.

## Left behind

Accepted at the round cap; these do not change what gets built.

- A newly promoted holder treats replicated decision rows as records from the agent's own machines, and the build should say so where it reads them.
- The stated token limits are estimates, so the first weeks may need retuning under `ecosystemIdeas.limits`.
- Two blind reads corroborate one another and are not independent proof, as the spec states for evidence generally.
