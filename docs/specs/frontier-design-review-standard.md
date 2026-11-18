---
title: "Design work runs on the frontier model and is reviewed before the operator is asked to approve it"
slug: frontier-design-review-standard
author: echo
eli16-overview: docs/specs/frontier-design-review-standard.eli16.md
parent-principle: "Structure beats Willpower"
tier: 2
origin: "Topic 144319, 2026-11-17. The Instar Windows App plan was written by an Opus 5.5 session in one pass of about four minutes with no review, and sent to Justin for approval. Justin, 13:01 PST: 'Our default standard should be to use the frontier models available in a design spec iteration process ... what do we need to change to make this the default behavior for an Instar agent?' Direction approved 13:06 PST ('Yes'). Standing rule, topic 141133, 2026-11-09 17:22 PST: 'we always should depend on frontier models such as fable 5.2 for design and review work and then lean on more efficient models for the actual task of building'."
lessons-engaged:
  - "Structure beats Willpower (the 2026-11-09 rule lived only in a memory note; nothing applied it)"
  - "Keep the Doorway/Model Map Current (the design model is one registry-governed pin, never an id typed into a brief or a skill)"
  - "Signal vs. Authority and Judgment Within Floors (records are signals; an LLM judge holds the authority inside a stated floor)"
  - "Verify the State, Not Its Symbol (the request carries a reference to an exact record, and the reviewed file is re-read before the request goes out)"
  - "Never Silently Cut the Data a Decision Depends On (exact lookup by reference; no record list is truncated into the judgment)"
  - "No Silent Degradation to Brittle Fallback (a model that could not be used is recorded and printed first, never hidden)"
  - "Capacity is the pool's state, never one account (room for the design model is read across the agent's accounts)"
  - "Counts are signals, not gates (the review loop stops on judgment; the round count triggers a decision, never a forced stop)"
  - "Single-provider functional floor (an agent with one provider and no frontier model clears every hold alone)"
  - "Updates never restrict existing agents (Echo's generalisation of Justin's words about privacy updates; engaged because graduation turns a hold on for existing agents, and answered by the hold being cleared by the agent alone on whatever models it has)"
  - "Blockers not falling means cut (rounds 1 to 5 cut the borrowed quota governor, the new setting, the session-notes route, the reach probe, the relaunch, the first-author claim, remote-spawn routing and job routing)"
  - "Migration Parity and Agent Awareness (reaches every existing agent on update)"
review-convergence: "2026-11-17T22:01:34.962Z"
review-iterations: 6
review-completed-at: "2026-11-17T22:01:34.962Z"
review-report: "docs/specs/reports/frontier-design-review-standard-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 13
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-11-17"
approval-evidence: "Justin, Telegram topic 144319, message 144458, 2026-11-17 15:32 PST: 'approved', replying to the approval request sent 14:08 PST (message 144392), which named the five things this yes covers (the 'What you actually need to decide' section of the overview)."
---

# Design work runs on the frontier model and is reviewed before the operator is asked to approve it

## Problem statement

On 2026-11-09 Justin set a rule: frontier models design and review, efficient models build. On 2026-11-17 a plan for the Instar Windows App was written by an Opus 5.5 session in a single four-minute pass, reviewed by nothing, and sent to him for approval. Three things were missing, and each one is structural:

1. **Nothing routes design work to a model.** The session that wrote the plan was started with a brief that named no model, so it took the default building model. The rule existed only as a note in the agent's memory.
2. **The review loop is scoped to Instar's own source.** `/spec-converge` (several reviewers, outside model families, repeated rounds, an 80/20 stopping rule) is described as "instar-developing agent only". A plan for anything else has no review loop to go through.
3. **The approval request does not say who designed and who reviewed.** The operator had to ask which model wrote the plan, and the answer had to be reconstructed from session records.

This spec makes the rule the default for every Instar agent by joining mechanisms that already exist and adding only the links between them.

## Ground truth from the code (main at e0a0e6128)

Checked in a fresh worktree from `origin/main` on 2026-11-17 and re-checked against source by the reviewers in every round.

| Existing piece | Where | State today | How this spec uses it |
|---|---|---|---|
| Model-Tier Escalation (`FABLE-MODEL-ESCALATION-SPEC.md`, `approved: true` 2026-06-09) | `ModelTierEscalation.ts`, `EscalationGovernor.ts`, `ModelSwapService.ts`; config `models.tierEscalation` | Built; ships `enabled: false, dryRun: true`; off on the development agent too. Its section 5.2, launch-time escalation for spawned sessions, has no call in the spawn routes. Its governor refuses `disabled` while that flag is off, takes a lease keyed to a live session and reads one account. | **Not reused.** This spec builds launch-time routing for design work without the governor and without touching `models.tierEscalation`. The mid-session swap stays off. |
| Doorway/Model Knowledge Registry (approved 2026-07-04) | `scripts/model-registry-freshness.manifest.json`, the strict freshness lint | Live. Each door lists `topModels` with `role` and `frontier`; named ids are pinned in source by regex, and each pin must be in its door's `frontier: true` set. `claude-fable-5-2` and `gemini-4-argon` are recorded as recognized, `frontier: false`. | Extended with one field per door, the design lane (section 1). |
| Reviewer-door rewiring (`REVIEWER-DOOR-REWIRING-SPEC.md`, converged 2026-07-04, built and tested; no `approved` field) | `src/core/crossModelReviewer.ts`; config `specConverge.reviewers.anthropic.*` | Built. A Claude reviewer family reads through the clean `claude -p` door on a pinned id. It is on for a development agent and dark on the fleet (`resolveDevAgentGate`). A non-frontier override is rejected and there is no fallback. | Reused as the same-door pass, with the two changes in decision 12. |
| `/spec-converge`, its driver and templates | `skills/spec-converge/`; installed on every agent. The driver `cross-model-review.mjs`, `publish-spec-review.mjs` and the seven reviewer templates are `alwaysOverwrite` in `PostUpdateMigrator.ts`; `SKILL.md` wording changes ship as marker-keyed one-shot migrations that skip customised copies. | Live, written for Instar specs. The driver has `--family` and `--detect-only`, fails on a flag it does not know, and does not call the server. Every `--family` path enters `runCrossModelReview`, which the feedback executor also calls for code review. A result has a status (`ok`, `degraded`, `unavailable`), a verdict (`CLEAN`, `MINOR ISSUES`, `SERIOUS ISSUES`, `UNKNOWN`) and one findings text; it has no finding counts. | Reused whole for Instar specs; the driver and templates are reused by a thin general skill (section 3). |
| Constitution-check hold (`spec-approval-constitution-check.md`, merged 2026-11-15, PR 3194; two days live) | `specConstitutionCheckLedger.ts`; rule `B25_SPEC_APPROVAL_UNCHECKED` (`blocking`, advisory-exempt) in `MessagingToneGate.ts`; `judgeSpecApprovalAsk` on Work Board writes. The gate returns one rule per verdict and has a slot for code-computed context. | Live on every agent. | Extended with a sibling rule on the same two surfaces (section 4). B25 itself is unchanged. |
| Hook events and usage records | `HookEventReceiver` stores each session's recent hook events in a file per Claude session id; a `PostToolUse` event carries `tool_name` and a top-level `file_path`, not the tool's input, and a subagent's event is stored under its parent session with nothing to tell it apart. `TokenLedger` rows carry the model actually used, keyed by the same Claude session id. | Live for Claude sessions. Events are bounded per session and per agent, so they age out. | Reused as the evidence of which sessions wrote to a file and on which models (section 3). |
| Session record | `Session.model` in `state/sessions/<id>.json` | The requested model or tier, set only when one was named; a default launch leaves it unset. | Set for design-lane launches. Not used as evidence of which model wrote a draft. |
| Subscription pool | `SubscriptionPool.accountRoom` reads the five-hour and seven-day windows; the per-model Fable window is stored on the account (`lastQuota.fable`) but placement does not read it | Live where a quota is readable. Codex has account windows only; Gemini has none. | Extended: room can be asked for a model (section 2). |
| Topic profile (approved 2026-06-11) | `TopicProfileResolver`, field `escalationOverride`; `TopicProfileOrchestrator` respawns a session whose launch differs from the resolved pin unless a `launchExpectation` was recorded | Live. `escalationOverride` has no reader on the spawn path. | Reused: `suppress` becomes the per-topic off switch; a design-lane launch records its expectation. |
| Per-Component Framework Routing (approved 2026-06-03) | the shared LLM-call funnel | Live. | Reused for the one new internal call (the design-work classifier, category `gate`). |
| Development-agent gate | `resolveDevAgentGate`, `config.developmentAgent` (per-machine config, read by the server and by the driver) | Live. | Reused as the rollout switch; no new config key. |
| Awareness registry | `src/data/awareness/*.md` | Live. | Reused (section 5). |

Adjacent specs this spec does not depend on: `nature-axis-routing.md` (converged, not approved) and `job-model-routing.md` (draft).

### What is new

1. A **design lane** in the model registry: one named model per door for design and review.
2. **Design routing at spawn** on `POST /sessions/spawn`.
3. A **general review skill** (`/design-review`), a driver mode that runs every reviewer in one command, and a **review ledger** of what the driver ran and what each reviewer concluded.
4. A **provenance line with a record reference**, rendered by code, and rule **B26** at the approval point.
5. One **constitution article**.

## Threat model

The agent is cooperating but forgetful: the failures this prevents are omissions (no model named, no review run, nothing disclosed). Shortcuts designed against, because a hold that can be talked past is prose:

- **A line typed from memory.** The line is rendered by code and ends in a record reference. Code looks the reference up exactly and checks that the request contains the record's line.
- **A review of something else.** The record is tied to the fingerprint of the reviewed file, and the server re-reads that file when the request goes out. A stub, a rewritten design, or a moved or deleted file reads as changed and is held. The judge is shown the record's title, so a reference borrowed from another design is visible.
- **A thin review dressed up.** Recording is only possible in the mode that runs every available reviewer, so a single hand-picked pass cannot produce a record. Each row carries the reviewer's own verdict, and the line prints the verdicts, serious ones first.
- **A design sent somewhere the operator did not choose.** Review reads the whole design. Outside passes go only to providers this agent's sessions already run on (decision 10), and a live secret stops the run.
- **Text that tries to instruct the judge or the classifier.** Both treat text as data inside a per-call boundary, as B25 does. The classifier answers `design` or `other`; a brief built from another agent's message can steer that answer, and the worst outcome is that its own session runs on the design model while an account has room.

Out of scope, as for B25: a session that deliberately forges records through the local API, which trusts the agent's own sessions. The driver runs in a process the session started, so its rows are evidence from review code, not from an independent observer.

## Frontloaded Decisions

1. **Design lanes: `claude-fable-5-2` for the Claude door and `gemini-4-argon` for the Gemini door, on the operator's word.** The registry's rule is that a model earns a lane by benchmark, and it records both as recognized but not promoted. Justin named Fable 5.2 for design and review (topic 141133, 2026-11-09; topic 144319, 2026-11-17) and asked for Gemini 4 Argon in the review process (topic 102965, 2026-10-17). Both manifest entries move to `frontier: true` with a note citing those messages, and the manifest's free-text review note on promotion is amended to "by benchmark, or by recorded operator ratification" so a later cadence review does not demote them. The Codex lane is `gpt-6-astra`, already that door's top model. The promoted entries keep their existing `role`; the only reader of the lane is the new resolver.
2. **Design routing outranks a topic's model pin; `escalationOverride: 'suppress'` turns it off for that topic.** The 2026-11-09 message pinned a topic to Opus 5.5 "for the actual work" and stated the design rule in the same breath, and the approved Topic Profile spec says escalation applies over a pin when the override is `inherit`. An explicit `model` in the spawn request still wins and is recorded.
3. **A model that cannot be used never blocks work.** The session or the reviewer pass runs on the default model, the reason is recorded, and the provenance line prints it first. A session is launched on the design model only on an account where a real call has already succeeded on it, which makes a refused launch unlikely, not impossible (see Under-block).
4. **Two things hold a request: the design as it stands has no review record, or the request does not carry that record's line.** Everything else is printed for the operator to weigh: which models are on record as writing it, which reviewers ran, what each concluded, and anything that could not be used. The design model and outside families take part by construction, because a record can only be made by the mode that attempts all of them.
5. **Sharing a draft is not asking for approval.** "Here is a first draft, not reviewed yet" passes. A request for the operator's yes is held whatever label the draft carries. The operator can approve anything at any time.
6. **No new review engine.** `/design-review` is a thin skill over the existing driver, templates and stopping rule. Instar specs keep `/spec-converge`.
7. **One constitution article is added** (full text under "Constitution wording"). Approving this spec approves that text. The 2.0 rule book is the master. The building session opens both pull requests, each naming the other as its counterpart as the pairing check requires, and merges the master's first; this approval is the yes for both merges.
8. **No new setting.** The standard is on where `resolveDevAgentGate` over `config.developmentAgent` says so, and off for the fleet until graduation, when the code default becomes on for every agent. There is no operator override of the model. Per-topic opt-out is `suppress`.
9. **Rollout follows the maturation ladder.** Graduation turns a self-clearable hold on for existing agents through an ordinary update. That is what was asked for; it is proven first on an upgraded single-provider agent and stated in the release note.
10. **Outside review uses only providers the agent already works through.** In recording mode an outside pass runs through a first-party CLI that is installed, signed in, and one of the agent's enabled frameworks (`enabledFrameworks`), meaning a provider this agent's own sessions already run on and which therefore already sees its work. A CLI that is merely signed in on the machine is not used; its pass is `unavailable` with the durable reason `disabled`, and the line says that provider is not enabled for this agent. An agent with one enabled framework has no outside reviewer, and its line says so. An operator adds an outside reviewer by enabling that provider for the agent, which is the existing setting. This is new behaviour of recording mode for the Codex and Gemini doors, which today open on sign-in alone, and it applies to `/spec-converge` when it records. The first draft of this decision used every signed-in CLI; review and the constitution check flagged that as sending designs to providers the operator had not chosen for this agent's work. Before any CLI is started in recording mode, the module runs the existing credential guard over the design text; a live secret stops the whole run before anything is sent, same-door pass included. Nothing is recorded, the driver exits naming the cause, and the agent's next step is to remove the secret.
11. **The review loop stops on judgment.** It ends when a round finds nothing that changes what would be built. When the existing round comparator judges that two consecutive rounds brought no improvement (in number or in seriousness), and at every sixth round, the session must stop and choose one of three things and say which in its output and in the request: continue, stating why progress is real; cut scope; or ask with the reviewers' verdicts as they stand. No count ends a review.
12. **The reviewer-door contract changes in two ways, and this approval covers them.** Where this standard is on for an agent, the Claude reviewer family is on in recording mode on every Claude agent unless `specConverge.reviewers.anthropic.enabled` is explicitly `false`; and it falls back once to the door's default model when the design model is refused, recorded and printed. Where the standard is off (the fleet before graduation), recording mode still records, with the family's existing gating. Outside recording mode nothing about `/spec-converge`'s reviewers changes. That spec left the fleet decision to the operator after use on a development agent; this approval is that decision, taken on its use there since the reviewer-door build. Its hardening preflight for untrusted text applies to every call, the fallback included, and a CLI that fails the preflight does not run. The reviewer-door spec's missing `approved` field is set by this build, citing this approval.
13. **Out of this version, each caught at the approval point instead:** spawns sent to another machine, sessions started by `POST /sessions/create`, scheduled jobs, and a topic's own long-running conversation session. Design work started those ways runs on today's model, and its approval request is held until it has a review record like any other.

## Open questions

*(none)*

## Proposed design

### 1. The design lane (registry)

`scripts/model-registry-freshness.manifest.json` gains one field per door, `designLane`, naming one id from that door's `topModels`. A new module `src/core/designLane.ts` exports `DESIGN_LANE_MODELS` (door to id, or `null`) and `resolveDesignModel(framework)`. The constant is pinned by the manifest's existing pin mechanism, so the id in code and in the registry cannot drift and the strict lint fails when the lane ages out of its review window.

`CLAUDE_REVIEWER_DEFAULT_MODEL` is defined from the same constant (its manifest pin moves to `designLane.ts` with it), and outside passes started in recording mode ask each door for its lane model. `claude-fable-5` stays in the Claude reviewer's accepted set so an existing override keeps working.

No skill, brief, prompt or awareness text contains a model id; they say "the design model". Changing the frontier later is one reviewed registry change shipped in a release. Nothing concrete is stored in agent config, and the seeded `models.tierEscalation` values are neither read nor rewritten.

### 2. Design routing at spawn

`POST /sessions/spawn` accepts two optional fields: `workKind: 'design' | 'build' | 'other'` (any other value is a 400) and `reviewHandoff: true` (section 3). `/design-review` and `/spec-converge` declare `design` when they start a session.

**Resolution order** (first match wins; every step before 5 is a cheap check with no model call):

1. The standard is off on this machine, or `resolveDesignModel` is `null` for the session's framework: today's behaviour, nothing recorded.
2. The request names a `model`: use it. Recorded as `explicit-model`.
3. The request targets another machine: today's behaviour. Recorded as `remote-not-routed`.
4. The topic's profile, read through the resolver, has `escalationOverride: 'suppress'`: today's behaviour. Recorded as `suppressed`.
5. The kind is the declared one. When none was declared, the classifier is asked. `build`, `other` or `unknown` gives today's behaviour, recorded with the kind and its source.
6. The kind is `design`: check plan and room (below). No confirmed plan access or no room gives today's behaviour, recorded as `lane-refused` with `not-confirmed`, `not-on-plan` or `no-room`.
7. Launch on the design model. Recorded as `design-lane`. The launch also records `applied` and a `launchExpectation` in the topic profile, as an explicit request does today, so the profile orchestrator does not respawn the session to restore the pin.

**The classifier.** One call through the shared LLM funnel as component `design-work-classifier` (category `gate`, fast tier), under the funnel's own per-call timeout and behind the route's existing `spawnLimiter`: is this session's main deliverable a plan, design, architecture or spec for something to be built, or the review of one? A brief that asks for a design and its build in one session is `other`, because the build should not run on the design model; the awareness entry tells agents to start design work as its own session. The brief is passed whole inside a per-call boundary; if it does not fit the model's input, no call is made. No answer, a rate limit or any error gives `unknown`. The classifier cannot fail a spawn. Its added latency is measured at each rung.

**Plan.** Whether the design model is on a login's plan cannot be read from any file, a session launch returns before the CLI has spoken to the provider, and this spec adds no probe and no relaunch. So the route launches on the design model only on positive evidence: this machine's review ledger holds a same-door reviewer pass that answered `ok` on the current design model under a given account, with no later `not-on-plan` refusal for it. The account on a row is stamped by the server from its own record of the reporting session (the pool's internal account id, never an email and never copied into a line, message or log; a session with no account recorded is the default login). That is the login the reviewer call ran under, because the reviewer's child process keeps the session's config home; stage 1 proves this for a session pinned to a non-default account. The route picks the account first, among accounts that have such a row and have room, and passes it to the launch through the existing account pin. When no account qualifies the result is today's behaviour, recorded as `lane-refused` with `not-confirmed`, `not-on-plan` or `no-room`. The same-door pass asks for the design model on every review run, so the first review under an account establishes its evidence and a plan change is picked up by the next one. The first design on a new agent is therefore written on today's model and reviewed on the design model, and its line says so.

**Room.** The pool's `accountRoom` function gains an optional model. For the Claude design model an account has no room when it is not active or when its per-model window, alongside the five-hour and seven-day windows it already reads, is at its limit and has not reset. A missing reading counts as room. Codex has account windows only and Gemini has none; with no pool there is one login and no reading, and room is assumed. If an account hits its limit after launch, today's handling of a walled session applies.

**What is recorded.** The session record gains `workKind`, `workKindSource` (`declared`, `classified`, `unknown`) and `designRouting` (`decision`, `reason`, `model`); `Session.model` is set from the launch model. The classifier call is logged by the funnel's existing decision-provenance record.

### 3. The review loop for every design

**Two loops, one engine.** A spec for Instar's own source goes through `/spec-converge`. Every other plan, design or spec goes through a new built-in skill, `/design-review`, which takes a document file (a plan that exists only in a chat message is written to a file first) and runs rounds of:

1. The built-in constitution check on the text (`POST /spec/conformance-check` with `markdown`).
2. **One driver run**: `cross-model-review.mjs --all --record`. It starts the same-door pass and one pass per outside family in parallel and reports the run to the server.
3. **Lens passes** as subagents using the existing reviewer templates. Which lenses fit is the reviewing session's judgment: the skill offers all six, and points to lessons-aware (reading the agent's own lessons) and decision-completeness as the two that most often change a short plan. Lenses improve the design; they are not recorded, counted or enforced. What is enforced is the driver run.
4. One coherent revision addressing every finding that changes what would be built.
5. The next round, until decision 11 ends the loop. A wording-only edit after the last round needs one more driver run, not a full round.

`/spec-converge` gets the same driver command through a marker-keyed `SKILL.md` migration of the kind its earlier wording changes used.

**The driver's recording mode.** `--record` is accepted only together with `--all`; a single hand-picked `--family` pass cannot make a record. A run does this, in the reviewer module so every caller of the mode gets it:

- scans the text with the credential guard and, on a live secret, exits before anything is sent or recorded (decision 10);
- attempts every family the module knows, writing a row for each: the same-door family, on as decision 12 says and kept out of the framework-activation baseline that `/spec-converge` reads, and each outside family that decision 10 allows. The same-door pass asks for the design model and, if that is refused, runs once more on the door's default model. In recording mode it asks for the design model whatever `specConverge.reviewers.anthropic.model` says, because that pass is also the evidence of plan access; the override keeps its meaning outside recording mode;
- gives the run an id of its own and posts one report to `POST /design/review/runs`, using `INSTAR_SERVER_URL`, `INSTAR_SESSION_ID` and `INSTAR_AUTH_TOKEN` from the session's environment. Only when the token variable is not set at all does it read the agent's token through `secret-get.mjs`; a variable that is set but empty marks a session started without authority, and the run fails loudly with nothing read, recorded or spooled. On a connection failure or a 5xx answer the driver writes the report to a spool file in the state directory; the server takes spooled reports in at its next start, and the driver's next run posts any that remain first. Both paths go through the route's validation under the session id in the report, and a spooled report that is refused is dropped and counted, never retried. The server ignores a run id it has already recorded and refuses one that arrives with a different fingerprint, so a report delivered twice is recorded once. Any 4xx answer fails loudly; it is never retried with a different token. A memory-private session is refused by the server's existing guard and cannot record, as it cannot run the constitution check today; it hands the run to an ordinary session.

The feedback executor's code reviews call the same module without this mode and record nothing.

**The run report and the ledger.** The report is `{ path, fingerprint, sessionId, passes: [...] }`. Each pass is `{ family, door, attempts: [{ askedModel, outcome, reason? }], model, modelBasis, status, reason?, verdict? }`:

- `status` is the module's own: `ok`, `degraded` or `unavailable`. A family that is not installed or not signed in still gets a row, so "never attempted" and "not available" cannot be confused.
- `reason`, on any attempt or pass that is not `ok`, is one of `not-installed`, `not-signed-in`, `disabled`, `not-on-plan`, `limit-reached`, `timed-out`, `call-failed`. The first four are durable (an installation, sign-in, setting or plan condition); the last three are transient (one call's failure). The module's own finer reasons map onto these by that rule: for example `claude-forbidden`, `claude-config-missing`, `codex-auth-apikey-forbidden`, `grok-not-enabled`, `grok-login-policy-unverified`, and `hardening-unsupported` when the CLI's flags are known to be missing, are durable; `provider-unavailable`, `model-resolution-canary`, and a hardening preflight that itself failed or timed out, are transient. That last split is a change to the module: today its preflight returns yes or no, folds its own failure into no, and caches the answer; it gains a third, inconclusive result with its own reason, which still does not run the call and is not cached. A reason the mapping does not know is transient and counted in the route's response. `attempts` keeps the refused attempt when a fallback then succeeds, so the line can say why the design model did not review.
- `verdict` is the reviewer's own, as the module already parses it: `CLEAN`, `MINOR ISSUES`, `SERIOUS ISSUES` or `UNKNOWN`. No finding counts are recorded, because the module has none.
- `modelBasis` is `reported` when the CLI's output named the model and `requested` when only the requested flag is known (Codex today).

The server is the only writer. It accepts a `path` only if its real path is a regular text file outside the state directory and inside the project directory, the agent home, or the working directory on the server's own record of the reporting session (an unknown or finished session id gets the first two only; a scoped session's id is taken from its token). The limit exists so the route cannot be used to read arbitrary files. A refusal to the agent's own session names the cause and the next step (for example, copy the plan into the project). The server reads the file itself and computes the design fingerprint: a hash of the whole text with line endings normalised, leaving out only these frontmatter fields, matched by exact key, which tools and the operator write after review: `provenance`; the convergence tag writer's fields (`review-convergence`, `review-iterations`, `review-completed-at`, `review-report`, `cross-model-review`, `cross-model-review-reason`, `single-run-completable`, `frontloaded-decisions`, `cheap-to-change-tags`, `contested-then-cleared`); `approved` and any key beginning `approved-` or `approval-`. A change to any other frontmatter field is a change to the design. This is a new function shared by the server and the driver; `/spec-converge`'s own delta check keeps its existing hash. The server refuses `document-changed-during-review` if its fingerprint differs from the driver's. It derives the title from the first heading as the constitution-check ledger does, validates every `model` against the registry's known ids, stamps time, machine and the reporting session's account, and appends the rows to `design-review-runs.jsonl` in the state directory. A file's history is keyed by its real path. The file is append-only. On load, an unparseable line is skipped and counted, so a torn last line after a crash is normal; before any append the server makes sure the file ends in a line break, so a torn fragment stays on its own line and cannot swallow the next record. There is no retention cut in this version: a row is a few hundred bytes, the maturation review reads the file's size, and a retention rule is added only on that evidence. The file is added to the state backup's include list; the spool file is not.

**Which sessions wrote it.** The stored hook events can show that a session wrote to a file. They cannot show which write created it, whether earlier writes have aged out, or whether a write stored under a session was made by one of its subagents. So the record claims only this: sessions running these models wrote to this file. At each run the server reads the stored events for `Write` and `Edit` calls on the file's real path (tool name, path, session id and time only) and appends one entry per write, identified by session id and event time: the session, the time, and the model on that Claude session's token-ledger rows immediately before and after the write when they agree, otherwise no model (a write with no later row yet has none). A write already recorded is appended again only when its model has become known, and entries are combined on read, so it then counts as attributed. A file created by a shell command or a copy has no write on record. A design written by an Opus session that named no model and revised by a Fable session during review reads "On record as written in sessions running Claude Opus 5.5 and Claude Fable 5.2". A plan that exists only in a chat message is written to a file by the session that holds it, before any hand-off, so that session is the one on record.

**Running the loop on the design model.** The skill's first step reads its own session record. If the session is not on the design model, was not started with `reviewHandoff`, its topic is not suppressed and step 6 of section 2 would not refuse the lane, it hands the document to one spawned session declared `workKind: 'design'` with `reviewHandoff: true`. If that spawn fails or the child ends without finishing, the parent runs the loop in place. A session started with `reviewHandoff` always runs in place, so there is one hand-off at most.

**What is derived on read, never stored.** For a file's real path and its current fingerprint:

- **times reviewed**: the number of runs for this file with at least one `ok` pass;
- **status**: `reviewed` when the current fingerprint has a run with an `ok` pass; `no-reviewer-reachable` when its latest run has no `ok` pass and every reason in it is durable; otherwise `not-reviewed` (a run that failed for transient reasons is run again);
- **verdicts**: each reviewer's verdict from the latest run on the current fingerprint;
- **design model took part**: an `ok` pass on the current fingerprint answered on the lane id;
- **outside family took part**: an `ok` pass from a provider family other than every model on the write record. With no write on record, the families are simply listed.

The recording routes and the skill are live on every agent from the release, so a dark agent can already build records. Routing, B26 and the same-door change are what the gate controls.

### 4. Provenance at the approval point

**The line.** `GET /design/review?path=<file>` answers for a path already in the ledger with `{ status, timesReviewed, writeRecord, passes, line, reference }`, and with `not-reviewed` for any other acceptable path. The line is rendered by code, uses the registry's display names, and puts first anything missing and any serious verdict:

> On record as written in a session running Claude Fable 5.2. Reviewed 3 times. On this version: Claude Fable 5.2 found no issues, GPT-6 Astra found minor issues, Gemini 4 Argon found no issues. (Review record 3f9a2c1b77d0)

> GPT-6 Astra found serious issues. Claude Fable 5.2 did not review this (limit reached); Claude Opus 5.5 reviewed in its place and found no issues. On record as written in a session running Claude Opus 5.5. Reviewed 2 times. (Review record 9c41d07e52ab)

Other openings it can print: "No reviewer could be reached (…)", "Review by Claude is turned off in this agent's settings", "No model from another provider reviewed this (none enabled for this agent)", "No record of which model wrote this", "Gemini 4 Argon gave no clear verdict". The write record names every model on record and adds "and at least one write with no model on record" when that is so; "on record" is the whole claim, and the line never says who wrote the design first or that the list is complete. The reference is the first twelve hexadecimal characters of a hash over the machine id, the file's real path and the fingerprint, so it names one document at one revision on one machine. The awareness entry says the reference is a lookup key, and tells the agent to say so to its operator the first time it sends one.

The source document may carry the line in its frontmatter as `provenance:` for readers of the file, but that copy is never a source: every rendering and every message takes the line from `GET /design/review` at the moment it is published. A rendering of the reviewed file prints it under the title. A rendering of a different file, such as the plain-English overview that `publish-spec-review.mjs` publishes, prints it as "Review record for the full design, <title>:" followed by the line, so the operator is not told the overview itself was reviewed. `publish-spec-review.mjs` is updated to carry the line and the constitution-check result in the message it composes; today it composes neither.

**Evidence computed by code.** Before the outbound gate's existing LLM call, code scans the text for references in the line's fixed form and, for each distinct one, builds an evidence entry from the ledger index (this machine's rows and rows fetched from peers): title, status, times reviewed, the write record, verdicts, and whether the text contains that record's line as it renders now. The comparison is made on the text as it reaches the gate, before any platform formatting, ignoring differences in whitespace and emphasis marks; a line fetched before a further run no longer matches and is fetched again. For a row this machine wrote, the server re-reads the file asynchronously, caching by modification time, and a different fingerprint or an unreadable path makes the entry `changed-since-review`. A path on a peer's row is never opened; the entry says the revision was not re-checked here. Other outcomes: `unknown-reference` and `records-unavailable` (the ledger file cannot be read at all).

The lookup is exact, so no "newest N records" list is involved, and B25's record block is untouched.

**Rule B26.** `B26_DESIGN_APPROVAL_UNREVIEWED` joins B25 in the outbound gate. The definition of a spec or design approval request is extracted from the B25 text into one shared constant. Given that a text is such a request, B26 fires when:

1. the text carries no record reference; or
2. no evidence entry for the design being asked about is `reviewed` or `no-reviewer-reachable` with its line present; or
3. the only such entry is plainly for a different design than the one the text asks about.

It passes a text that is not an approval request, a request about something other than a spec or design, a draft shared without asking, and a request whose entry is `reviewed` or `no-reviewer-reachable` with its line present, whatever the line says. Under-fire bias applies to whether the text is a request and to whether a title is a different design; the code-computed parts are not judgments. When it fires, the suggestion names the agent's own next step: run `/design-review` on the document and send the request again with the line; if review cannot run at all right now, share the design as an unreviewed draft without asking for approval. That loop runs the constitution check too, so one run clears B25 and B26; because the gate returns one rule, when both apply it cites B25 and the suggestion names the one run that clears both.

Disposition: `blocking`, listed in `ADVISORY_MIGRATION_EXEMPT_RULES`, for B25's reason: an acknowledgeable nudge would let the judgment that skipped the review wave the request through.

**Work Board.** `judgeSpecApprovalAsk` gets the same code-computed evidence for the card's text and applies both rules in its one call. A B26 fire returns 422 `design-approval-unreviewed` with the issue and the way through; when both fire, one 422 lists both. Its availability behaviour is unchanged.

**Why not the documents route.** Publishing a document is not asking for approval, and the documents feature is off on the fleet. The request reaches the operator as a message or a card, and both already pass through the B25 judge.

### 5. Reaching every agent

| Change | Path to an existing agent |
|---|---|
| Design lane, routing, ledger, routes, B26, Work Board judge, driver module changes | Code in the release. Routing, B26 and the same-door change sit behind `resolveDevAgentGate` until graduation. |
| `/design-review` skill | New built-in skill; `installBuiltinSkills` writes missing skills on every update. It calls the driver and templates under `.claude/skills/spec-converge/`, which are installed on every agent whatever framework it runs. |
| Driver script and `publish-spec-review.mjs` | Already `alwaysOverwrite`. |
| `/spec-converge` `SKILL.md` wording | One marker-keyed migration that skips customised copies. |
| Agent awareness | One entry, `src/data/awareness/frontier-design-review.md`: start design work as its own session; before asking approval for any plan, design or spec, run the review loop and carry the provenance line; where to read the record; the reference is a lookup key. It gives the steps as one driver command and plain HTTP calls, so an agent whose skill rendering holds `SKILL.md` only can follow it. No model id in the text. |
| Registry | Manifest field, promoted entries, amended note and pin, in the same change as the code that reads them. |
| Constitution article | Two pull requests opened together by the building session, each naming the other as its counterpart: the 2.0 rule book's, merged first, and the registry article with its checklist (hierarchy regeneration, coverage count, family audit refresh, alignment-map row, the 2.0 briefing-sync check). Stage 4 is complete when `scripts/check-constitution-pairing.mjs` passes for the pair. |

There is no dashboard surface in this spec.

## Verify the state, not its symbol

| What is claimed | Symbol read | State it stands for | Corroboration | When it cannot be measured |
|---|---|---|---|---|
| This design was reviewed | A run with an `ok` pass for the current fingerprint | Review code read this exact text | The server hashed the file itself when the run was reported and re-reads it when the request goes out | No run, or a run that failed for a transient reason: `not-reviewed`, held. File moved or unreadable: `changed-since-review`, held. Ledger unreadable: `records-unavailable`, held |
| The request is about the reviewed design | The reference and the rendered line in the text | The operator is asked about the text that was reviewed | The fingerprint re-check; the judge's comparison of the record's title with the request | Reviewed on another machine: stated as not re-checked here, not held |
| Which model reviewed, and what it concluded | `model`, `modelBasis` and `verdict` on the row | The model that read the design and its conclusion | The CLI's own usage output for Claude; the module's concrete-model check before every call; the verdict is parsed from that call's output | Codex is `requested` today and the record says so. A verdict of `UNKNOWN` is printed as "gave no clear verdict" |
| Sessions running which models wrote to it | Stored `Write` and `Edit` events for the path | That sessions wrote to the file | The token-ledger rows immediately before and after each write, which carry the model actually used | Rows disagree or are not read yet: that write has no model on record. No stored write (shell, copy, aged out): "No record of which model wrote this". The claim is "on record", never "first" or "all". Never held |
| The design model could not be used | A refused pass or launch and its reason | This login could not reach it at that time | It is the result of an actual call | No record either way: unknown, and the launch or pass is attempted |
| Times reviewed | Runs with an `ok` pass for the file's path | How many times review code read the design at that path | Each run has a driver-generated id the server records once | A run with no `ok` pass is not counted |

A missing or stale record holds a request the agent clears by one driver run. An unknown never holds by itself and is always printed.

## Multi-machine posture

- **Design lane: `unified`.** Compiled into the release from the git-tracked registry.
- **On or off.** After graduation it is `unified`: on in code for every machine. Until then it follows `developmentAgent`, an existing per-machine config value this spec does not introduce. In a pool where machines differ, routing and B26 apply on the machine that spawns or sends, and a machine with the standard off still serves and accepts ledger rows, because the recording routes are always live.
- **Review ledger: proxied-on-read.** Each machine appends the rows its own server received and serves them at `GET /design/review/runs?since=<cursor>`. When a reference misses locally, the reviewing server fetches peers' rows through the pool's existing peer fetch, no more often than the constitution-check peer cache refreshes, and the agent's re-send finds them. Rows are immutable and merged as a union keyed by machine and run id, so a design reviewed on two machines keeps every run. A peer row is untrusted data: `title` and `path` are clamped to the lengths the constitution-check ledger uses, `fingerprint` and `runId` must be fixed-length hexadecimal, the account id is clamped and never rendered, `family`, `door`, `modelBasis`, `status`, `reason` and `verdict` must be from their closed lists, `model` must be a known registry id, and status and line are always recomputed locally. The spool file is local and transient and is not backed up.
- **Write records** are resolved on the machine that holds the sessions' hook events and token ledger and travel as rows. **Plan evidence** is read from this machine's rows only, since an account is a login on this disk.
- **Re-reading the reviewed file** happens only on the machine whose row it is.
- **Whether the design model is usable on a machine: machine-local by design.**
  machine-local-justification: physical-credential-locality — plan access and room depend on the Claude or Codex login on that disk and its plan and quota; they cannot be replicated without replicating credentials.
- **Spawns sent to another machine are not routed** in this version (decision 13).
- **Holds go only to the sending agent.** No operator-facing notice, no generated link, nothing that strands on a topic transfer.
- **Single machine:** everything works with no peer.
- **Self-Heal Before Notify does not apply:** this spec adds no monitor, watcher or recurring notice source.

## Decision points touched

| Decision | Kind |
|---|---|
| Is this spawn design work, when nothing was declared? | judgment-candidate — floor: the only outcomes are the design model or today's default; no answer, an error, a rate limit or an oversize brief gives `unknown` and today's default; ladder: declared kind, one fast-tier call, `unknown`; arbiter: the design-work classifier. It cannot fail or hold a spawn. |
| The classifier reads the whole brief or is not asked | invariant; basis: external-constraint; evidence: a model's input size is set by its provider, and a truncated brief would be a silent cut of decision data |
| Which source of a spawn's model wins | invariant; basis: enumerable-domain; evidence: the seven ordered steps of section 2 cover every source and each outcome is recorded on the session |
| Is the design model on this account's plan? | invariant; basis: external-constraint; evidence: the provider decides plan access, and a launch cannot report a refusal back to the route; so the lane needs a recorded successful real call under that account with no later refusal, and anything else gives today's model |
| Is there room for the design model? | invariant; basis: external-constraint; evidence: a provider's usage limit is a hard wall; the test is the stored window at its limit and not yet reset, with no added margin; a missing reading counts as room |
| Is this outbound text a spec or design approval request that lacks its review? | judgment-candidate — floor: hold or pass only, never rewrite; the reference lookup, the word-for-word line check and the fingerprint re-check are done by code and shown as data; under-fire bias on whether it is a request and on whether a title is a different design; ladder: the outbound gate's existing availability behaviour, unchanged; arbiter: the outbound gate's LLM (rule B26) |
| Is this agent-written Work Board card such a request? | judgment-candidate — floor: write or refuse with the way through; ladder: fast tier, balanced tier, retryable named 503, no-provider pass-through with a log; arbiter: `judgeSpecApprovalAsk` |
| What a record reference resolves to | invariant; basis: enumerable-domain; evidence: a pure function of the ledger rows for that fingerprint with six outcomes (`reviewed`, `no-reviewer-reachable`, `not-reviewed`, `changed-since-review`, `unknown-reference`, `records-unavailable`) |
| A request needs one review run for the text as it stands | invariant; basis: enumerable-domain; evidence: zero runs means review code never read this text, and one is the smallest number that is a review; how many more is the stopping judgment's |
| A report with a run id already recorded is ignored | invariant; basis: enumerable-domain; evidence: a run id is either in the ledger or not, and counting one run twice would overstate the review |
| A record can be made only by the run that attempts every reviewer | invariant; basis: enumerable-domain; evidence: the families the module knows for the agent's doors are a closed list, each gets a row with a status, and a partial run has no way to report |
| A live secret in the text stops the run | invariant; basis: irreversible-consequence; evidence: text sent to an outside provider cannot be recalled |
| Has the review converged, and what to do when it stops improving? | judgment-candidate — floor: a round with no design finding ends it; when the comparator judges two consecutive rounds brought no improvement, and at every sixth round, the session must choose and state one of continue with its reason, cut scope, or ask with the verdicts as they stand; no count ends a review; arbiter: the reviewing session with the existing fractal 80/20 comparator |
| Which lenses does this design need? | judgment-candidate — floor: the full driver run in every round is enforced and lenses are not; default: all six; arbiter: the reviewing session |
| The same-door pass falls back to the door's default model once | invariant; basis: enumerable-domain; evidence: the door has two candidate models here, the lane and the default, so one fallback exhausts them |
| Hand the loop to a design session, or run in place? | invariant; basis: enumerable-domain; evidence: four cheap facts decide it (already on the design model, already handed off, topic suppressed, lane refused for plan or room), and a failed or ended child returns to running in place |
| What the write record says | invariant; basis: enumerable-domain; evidence: each stored write either has one model on the ledger rows either side of it or has none on record; a file with no stored write has no record; nothing is inferred and no claim of first author or completeness is made |
| Peer rows are merged as a union and re-derived locally | invariant; basis: enumerable-domain; evidence: rows are immutable facts keyed by machine and run id; a peer row can add a run but cannot assert a status |
| Which files a run may be recorded for | invariant; basis: irreversible-consequence; evidence: the route reads a file a caller names and copies its heading into a ledger peers fetch, so an unbounded path would disclose arbitrary files; three roots minus the state directory, with the session's directory taken from the server's own record |
| A report whose file changed during the review is refused | invariant; basis: enumerable-domain; evidence: the server's fingerprint either equals the driver's or does not, and a record of text nobody reviewed would be false |
| When no reviewer answered, does the request still pass? | invariant; basis: enumerable-domain; evidence: the reason list is closed and split in two; all durable reasons means nothing on this machine can review and the line says so first; any transient reason means run again |

## Over-block and under-block

- **Over-block.** A message that mentions approving a design in passing could be judged a request. The shared definition and its pass list are B25's, which has two days of live use, so false holds are counted at each rung. A design reviewed on a peer needs one re-send. A single-provider agent with no frontier model clears every hold alone: its same-door pass on the default model makes a record, and the line says first what was not available. An agent on which no reviewer is installed, signed in or on the plan still clears: the run records that, and the line opens with it.
- **Under-block.** When the gate's LLM is unavailable and the operator-tier delivery path applies, the message is delivered unjudged, as for every rule. A request split across two messages, or phrased so the judge does not read it as a request, is the residual B25 shares. A design reviewed on another machine is not re-read. A design saved over an old file's path continues that file's history, so "Reviewed N times" and the write record can include the earlier design; the verdicts printed are always for the current text. A login that was replaced or lost the design model since its last successful review can still be launched on it once; that session then sits at the provider's refusal as any session started with an explicit model does today, and the next review run records the refusal. Design work started by the routes in decision 13 is not routed, and a brief that mixes design and build runs on today's model; both are reviewed only when approval is asked, so a design that is built without ever asking for approval gets neither routing nor review, and only the awareness entry speaks to that. Nobody has to remember to split a mixed brief for the review to happen: the hold and the hand-off put review and revision on the design model. An agent's first design, before any review has confirmed plan access, is written on today's model. A review is recorded as run, with each reviewer's verdict, not as resolved: an agent can ask for approval while a reviewer's verdict is "serious issues", and the operator sees exactly that.
- **Cost.** Design sessions, their lens subagents and the same-door pass use the scarcer model's allowance, bounded only by the provider's limit; this spec adds no budget. When no account has room, routing and the pass fall back and the line reports it. Use of the design model's weekly window is measured at each rung.

## Maturation plan

- **test-agent-live:** each build stage runs first on throwaway agents with a test Telegram bot and a test Slack app, driven as the user through the real channels. The rare cases are proven here, not waited for: a no-room refusal, a plan refusal, a changed-since-review hold, a two-machine request, an agent with one provider and no frontier model upgraded from the previous release.
- **dev-agent-live:** then on the development agent (today Echo), on Justin's real design requests.
- **fleet:** delivered dark by the release; the code default turns on for every agent when the graduation criterion holds.
- **graduation criterion:** decided by the existing maturation review over real design requests on the development agent that exercised a routed spawn, a held request and a cleared hold: every approval request for a design carried a line resolving to a record; every hold was cleared by the agent alone; false holds are counted and each is traced; the classifier's added spawn latency and its agreement with a design-model reading of sampled briefs are reported, with each disagreement traced; the design model's weekly window kept room for other work; the share of design requests not written on the design model is reported by how the session was started, and stays a standing line in the weekly maturation review after graduation so the next version routes whichever start the numbers show; one design request is read end to end as Justin received it, with the time from his request to the approval ask; zero operator-found requests without provenance. Missing evidence records `incomplete`, never a pass. No minimum duration.
- **dark-window:** the fleet stays dark until the graduation criterion holds; the weekly maturation review then records the fleet outcome. No fixed duration.
- **ladder:** frontier-design-review
- **Owner:** Echo.

## Build stages with live proof

1. **Lane and routing.** Registry field, promoted entries and pin, `designLane.ts`, spawn-route steps, classifier, model-aware room, the plan evidence check, session record fields, launch expectation. Proof on a throwaway agent: a declared design spawn, an undeclared design brief, a build brief, a mixed brief, a suppressed topic, a pinned topic, an explicit model, a remote target, an account with no confirming review yet and a no-room pool each launch on the expected model with the expected record, and a pinned topic's design session is not respawned. The cases that need recorded reviews (an account with a recorded plan refusal, a pool where only one account is confirmed, a session pinned to a non-default account whose review confirms that account) are proven in stage 2.
2. **Driver mode, ledger and `/design-review`.** Proof: a real short plan goes through the loop; the ledger shows the run the driver made; the line reads correctly with all reviewers, with one provider only, with an outside CLI signed in but not enabled for the agent, with the design model refused, with a reviewer finding serious issues, with no reviewer installed, with every call timing out, with a live secret in the text, for a draft written by a session that named no model, for a file created by a shell command, for a file replaced by a rewrite between runs, for a report delivered twice, for a spooled report that no longer matches its file, after a hand-off, after the file is edited or moved, after a crash that left a torn last line, with an existing reviewer model override in config, and after a server restart mid-run; and the three plan-evidence cases carried over from stage 1.
3. **B26, Work Board judge, publish script.** Proof through real Telegram and Slack: a request with no reference is held; a typed reference is held; an edited design is held; the real line is delivered; a draft shared without a request is delivered; a card is refused and then accepted; a request sent from a second machine clears on re-send; a request needing both checks is cleared by one run; a line sent through Telegram and Slack formatting still matches; a published overview carries the "for the full design" wording.
4. **Awareness, migrations, constitution article.** Proof: an agent on the previous release updates and has the skill, the awareness text, the updated driver and the migrated wording; a second update changes nothing; the pairing check passes for the two constitution pull requests.

Each stage ships unit, integration and end-to-end tests under the Testing Integrity Standard, with both sides of every decision row above and wiring checks for the judge, the evidence step and the ledger.

## Rollback

The fast rollback is a release that sets the gate off for every agent: routing and B26 stop, the recording routes, the driver mode and the migrated wording keep working, and nothing dangles. A full revert of the code restores a driver that rejects the new flags, so it must ship in the same release as a reverse migration of the `/spec-converge` wording; the turn-off release needs neither. The ledger file is inert without the code that reads it. A request held at the moment of a rollback is delivered on re-send. When the standard turns on for an agent, a design request drafted but not yet sent is held once and cleared by one driver run.

## Out of scope

- Mid-session model swaps (the rest of Model-Tier Escalation). They stay off, with their own rollout.
- Routing for remote spawns, `POST /sessions/create`, scheduled jobs and running conversation sessions (decision 13).
- Choosing models for internal LLM calls.
- A setting for this standard; there is none.
- Rules for what a plan must contain. This spec governs who designs, who reviews and what the operator is shown.
- A hold based on what the reviewers concluded. The verdicts are shown; the decision is the operator's.

## Constitution wording

One article. The 2.0 rule book (the master) receives the same obligation in its own form first; the 1.x Standards Registry article, placed under *Structure beats Willpower*, reads:

> ### Frontier Models Design and Review; Efficient Models Build
> **Rule.** Plans, designs and specs are reviewed on the strongest model the agent can reach, named in the model registry, and are drafted on it wherever the work can be routed there; building runs on the efficient default. Before the operator is asked to approve a design, review code has read the design as it stands, with a model from another provider the agent already works through where one is reachable, and the request states which models are on record as having written it, which models reviewed it, what each concluded and how many times it was reviewed, from records the system wrote.
> **Fails.** A model that cannot be reached does not stop work: the work runs on the default model and the request says so first. A request with no record for the design as it stands is held until the agent runs the review, and a record that cannot be read holds the same way. When nothing on the machine can review, the request goes out saying exactly that. The check never passes a request silently; when the message gate itself is down, its existing delivery rule applies as for every other rule.
> **In practice.** The design model is one pinned entry per door in the model registry; no brief, skill or prompt names a model. A session spawned on the same machine and declared or judged to be design work launches on it when an account with confirmed access has room. The review driver's recording mode attempts every reviewer and writes what each concluded. The outbound gate and the Work Board hold an approval request that does not carry its record's line.
> **Earned from.** 2026-11-17, topic 144319: a plan for the Windows app was written by the building model in one four-minute pass, reviewed by nothing, and sent for approval eight days after the operator's rule (2026-11-09, topic 141133: "we always should depend on frontier models such as fable 5.2 for design and review work and then lean on more efficient models for the actual task of building") had been stored as a memory note that nothing applied.
> **Traces to the goal.** A coherent agent puts its strongest judgment where a mistake costs most, which is the design, and shows its operator what stood behind a request for their yes.
> **Applied through.** `src/core/designLane.ts`; the design-routing steps of `POST /sessions/spawn`; `/design-review` and the driver's recording mode; `B26_DESIGN_APPROVAL_UNREVIEWED`; `docs/specs/frontier-design-review-standard.md`. **Parent principle:** *Structure beats Willpower*.

## Constitution alignment

- **Structure beats Willpower (parent).** A rule kept in a memory note is replaced by a routing step at spawn and a hold at the approval point.
- **Keep the Doorway/Model Map Current.** The design model is one registry pin under the strict freshness lint; no id is typed anywhere else, and there is no per-agent override to rot. The promotion rule is amended openly, not bypassed.
- **Signal vs. Authority; Judgment Within Floors.** Ledger rows, the session record, the classifier's answer and the code-computed evidence are signals. The outbound judge holds the blocking authority inside the floors in the decision table. Looking up a reference the system issued, and checking for its own rendered line, are not meaning judgments and are done by code.
- **Intelligent Prompts — An LLM Gate Must Not String-Match.** Whether a brief is design work, and whether a text asks for approval, are judged by meaning.
- **Verify the State, Not Its Symbol.** The request is tied to the reviewed text by fingerprint and the file is re-read; rounds are runs, not revisions; each remaining symbol is declared with its unmeasurable case.
- **Never Silently Cut the Data a Decision Depends On.** B26's evidence is an exact lookup; the classifier reads the whole brief or is not asked.
- **No Silent Degradation to Brittle Fallback.** Every fall-back to a default model is recorded and printed first; an unreadable ledger holds instead of passing.
- **No Unbounded Loops.** The review loop has a stopping judgment and forced checkpoints; the hand-off, the same-door fallback and the classifier call each happen once.
- **Sovereignty.** A design under review is read only by providers the agent's own sessions already run on; a provider that is merely signed in on the machine is not used.
- **Agent Proposes, Operator Approves.** The operator still gives one approval; the request now carries what they need to weigh it. Every hold is cleared by the agent.
- **Self-Hosting.** The review loop Instar uses on itself becomes a capability every agent has for its own designs.
- **Cross-Machine Coherence; Migration Parity; Agent Awareness.** Posture, update paths and the awareness entry are stated above.
- **One Constitution, Two Books Aligned.** The article lands in both books, master first; each pull request names its counterpart.
- **Occam's Razor.** One resolver, one flat ledger and one rule join mechanisms that already exist. Review removed the borrowed quota governor, the new setting, the session-notes route, the reach probe, the relaunch, the first-author claim, and routing for remote spawns and jobs.
