# Convergence Report — Job cost reduction (revision 2: Jev triage supervision)

## Cross-model review: codex-cli:gpt-6-astra

A real outside (GPT-tier) review ran through the agent's Codex CLI in **all six
rounds of this revision** (and all six of the first convergence). Every round
returned "serious issues", and every design finding was handled in the spec.
Gemini was not signed in, so there was no Gemini pass. The clean-door Anthropic
second read (`claude-code:claude-fable-5`) was attempted twice in round 1 and
came back degraded (error) both times; it is a disclosure field, not the
cross-model pass, and was not retried.

## ELI10 Overview

This spec turns 17 built-in scheduled jobs into plain scripts, so the agent stops
spending a 240,000-token AI session every few minutes just to run one fixed
command. The first converged version replaced the per-run AI watcher with a daily
practice test and one daily AI review.

Justin then decided (2026-10-26 19:04) how supervision should really work: Jev, a
very cheap classifier, looks at each job's result and decides whether it needs a
real AI session to deal with it; Luna (or Haiku) checks Jev when Jev is unsure
and again every few hours as a backup; and one high-level review runs daily. This
revision builds that in. Five jobs whose results can carry something a fixed rule
cannot read get Jev triage; the others don't need it. A fixed rule (a job failing
twice in a row, or a serious problem like a nearly full disk) always gets a
session whatever Jev says, so an agent with no Jev and one AI provider still works.

When triage asks for a session, it gets an investigator: a fixed brief, a short
list of tools, no credentials in its environment, no MCP servers, and an
instruction not to re-run the job or message the operator; what it found is
recorded. Sessions are capped (one per problem every 6 hours, 3 per job and 6 per
machine a day). Sending job results to Jev (an outside service) is switched on
only for development agents.

## Original vs Converged

- **Triage sessions were going to re-run the job.** The first draft started the
  job's own body as the session. For four of the five jobs that body is "call
  this endpoint once", so the "investigation" would have repeated the work, and
  health-check's body would have messaged the operator at once, defeating the
  6-hour quiet rule. Now: a fixed investigator prompt in code, the body as
  reference only, a confined tool set, no credentials, no MCP servers.
- **Jev could veto a needed session.** The fixed rule was only a fallback when
  Jev was missing. Now the decision is "fixed rule OR Jev": Jev can only add
  sessions.
- **The Claude-only path did not exist.** The existing referee was Codex-only.
  Now the referee and backup use Codex (Luna) when present, else the agent's own
  framework at its fast tier (Haiku), each behind its own single-call wrapper and
  breaker.
- **Egress was fleet-wide.** Now Jev triage is development-agent only, the
  feedback-factory jobs send only structured fields (a new `JOB_FIELD` line
  format), and every model consumer reads one evidence projection.
- **Self-Heal Before Notify.** The 6-hour notice used to fire on elapsed time
  alone; now it waits for one investigation (or names why none could start),
  with a hard deadline so it can never be held forever.
- **Sends.** Pushes now go through the automation reply chokepoint (tone gate,
  credential guard, origin recording) instead of a raw topic send; a tone-gate
  advisory is acknowledged with a fixed reason instead of silently dropping the
  evidence; a block falls back to a private-view link.
- **Rollout.** Script runners and Jev triage now ride the development-agent gate;
  the fleet keeps today's behaviour until later PRs switch it.
- **Spec 2 reconciled.** §5.6.6 says which spec owns every job; nothing is both
  triaged here and Jev-gated there.

## Iteration Summary

| Round | Reviewers who raised design findings | Design findings | Left behind | Main spec changes |
|---|---|---|---|---|
| 1 | security+adversarial 8, scalability+integration 12, decisions+lessons 10, Codex 3; gate 1 flag | 33 (heavily overlapping) | ~22 | investigator prompt + projection, additive floor, referee provider, caps, egress gate, sampling, heal-then-push, ownership table |
| 2 | Codex 3, all-lenses internal 6; gate not re-run | 9 | 8 | floor not coalesced, cascade-only fingerprint reuse, structured-only evidence, sendAutomationReply, hard deadline, local streak, default model |
| 3 | Codex 2, internal 2; gate not re-run | 4 | 9 | one evidence projection for every consumer, script vs session timeout, `omitAuthEnv`, advisory ack |
| 4 | Codex 3 (internal not run: round-3 internal fixes were checked by Codex) | 3 | 1 | honest trusted-agent framing, `JOB_FIELD` transport, referee slot |
| 5 | Codex 2, internal 1 | 3 | 6 | single-flight wrapper, trust-rejected runs excluded, rerouted-lane `omitAuthEnv` build item |
| 6 (cap) | Codex 2, internal 3 (1 security); gate 2 flags on the final text | 5 + 1 from gate | 6 | per-episode admission, no owner suppression, confined Claude tool args, separate slots, one canary item, push-retry brakes |

Standards-Conformance Gate: round 1 ran (1 flag: Self-Heal Before Notify, addressed);
rounds 2–5 were not re-run (honest gap: skipped to keep rounds short); round 6 ran
on the final text (2 flags: push retry without brakes, fixed; and the critical-class
notify-and-heal exception, contested and cleared below).
Internal reviewers ran on claude-opus-5-5 subagents; rounds 2–6 ran the six lenses
as one combined reviewer.

## Proportion

Tier 2 (scheduler execution path, session spawning, third-party egress, alerting,
migration to every agent). This revision used 6 of 6 rounds on a ~250-line
rewrite of §5.6 in a ~1,500-line spec. ⚠ Design findings kept arriving through
round 6, each smaller than the last; the triage session's authority (tools,
credentials, lanes) is where they concentrated, and it should get the closest
look in code review.

## Left behind

**Round-6 design findings resolved by the reviewers' own exact fixes, not
re-reviewed (cap):** confined tool arguments (`CLAUDE_CONFINED_PERMISSION_ARGS`,
no MCP), separate referee/backup slots with a 10-minute breaker, one canary item
per machine, per-episode admission, no owner-item suppression, push-retry brakes.
These adopt existing code patterns; the build's code review checks them.

**Contested and cleared:** the gate's claim that the critical-class immediate
push lacks a basis. The Self-Heal Before Notify standard as written in
spec-converge Standard B gives irreversible/data-loss classes same-tick escalation
with concurrent heal; `disk-critical` and `undelivered-reminders` are that class.

**Precision items not iterated on:**
- the forward/reverse Jev agreement is coarse (label equality); a probability-gap
  rule may calibrate better later;
- Jev's dollar ceiling is stated in tokens, not dollars (TypeSafe pricing not in
  the repo);
- the 0.30–0.70 band is the browser-research band, not calibrated for this question;
  the audit share and backup disagreements are the data that will set it;
- codex triage sessions have no tool narrowing (stated in the spec);
- `INSTAR_JOB_SLUG` with a colon in `triage:<slug>`: the build derives file names
  from the tmux name;
- triage calm items and the Jobs-tab triage column wording;
- `JobRun.machineId` missing on old rows: treated as local only on a
  single-machine agent;
- the daily review's 60k-character clamp ordering;
- `notifyJobComplete`'s early return is bypassed by a `triage:` branch;
- the canary "triage floor" assertion lists per-script expected verdicts in tests;
- disagreement samples are not calibration labels until settled;
- the triage session's ability to read run history directly (scoped claim).

## Full Findings Catalog

Round 1 (33 design, condensed; duplicates merged):
- Triage session re-runs the job body / trigger-only templates (security, integration, lessons, Codex) → fixed investigator prompt, body as reference.
- Triage session messages the operator, defeats §5.4 (adversarial, integration) → no telegramNotify; later `omitAuthEnv`.
- Triage session has `*` tools; `resolveAllowlist` gives `legacy` full tools to a script-typed def (security, integration) → agentmd projection with fixed allowlist.
- Jev egress fleet-wide (security, integration, decisions) → dev-gated `jobs.scriptTriage.jev.enabled`.
- Floor only a fallback (adversarial, scalability, lessons) → `floor OR cascade`.
- Cooldown per slug blocks other conditions; shared cap starvation (adversarial, scalability) → reason-set key, per-slug cap, critical bypass.
- Backup reads 12 of ~72 runs; cursor ambiguous (all three + Codex) → honest sample, fingerprint dedupe, unread counts, persisted ids.
- `askReferee` cannot carry attribution; boolean-only answers (security, integration, Codex) → optional attribution argument; single boolean rule.
- No code path spawns a script job as a session (integration) → derived agentmd projection, also used for rollback.
- Triage session resets the failure streak and JobState (integration) → `origin: triage` row, excluded.
- Live triage session skips the job's next runs (integration) → slug tag `triage:<slug>`.
- Admission checks live in triggerJob (integration) → `admitTriageSpawn()`.
- Claude-only referee does not exist (integration, lessons) → provider construction.
- Referee uncapped (lessons, scalability) → 200/day, 20 s, one in flight.
- 6-hour push not downstream of a heal (lessons, gate) → heal attempt then push.
- Machine-local justification wrong/undefended markers (integration) → standalone markers, pool cooldown check.
- Triage blocks the script slot (scalability) → after claim release, queued.
- Forward/reverse order undefined (lessons, security) → forward tests band, disagreement to referee.
- F10 cheap tag contested (decisions) → not cheap.
- Bare-ok triage is pure cost (lessons) → bare-ok and fingerprint skip.
- mentor-onboarding two-hats conflict (lessons) → deterministic.
- G1 promise contradicted (Codex, precision) → reworded.

Round 2: fingerprint reuse bypassing the floor; latest-only queue dropping floor work; triage-disabled persistence push (Codex); structured-only evidence for fleet-user text; push path skips tone gate/credential guard; unbounded heal wait; triage session model tier; standby streak; relay refusal gaps (internal) → all fixed as listed above.

Round 3: evidence projection not applied to backup/review; rollback session timeout (Codex); credentials reachable through other routes → `omitAuthEnv`; tone-gate holds dropping verbatim evidence → advisory ack (internal).

Round 4 (Codex): `omitAuthEnv` overstated as isolation → honest trusted-agent framing; no structured-evidence transport → `JOB_FIELD`; referee slot not enforceable by timeout race → slot held until settle.

Round 5: referee slot not enforceable through `askReferee`'s API → `SingleFlightProvider`; trust-rejected runs vs floor (Codex); rerouted lane ignores `omitAuthEnv` (internal, code-confirmed) → build item + test.

Round 6: per-episode admission; owner-item suppression unverifiable (Codex); deny-list tools miss MCP → confined args (internal, security); shared slot mutual failure; canary item flood (internal); push retry without brakes (gate).

## Convergence verdict

Converged at the round cap (6 of 6) for revision 2. The final round's design
findings were resolved with the reviewers' own concrete, code-backed fixes and
are listed above; none remains open. 0 open questions; 19 frontloaded
decisions; 1 cheap-to-change tag (the runner flag) survives. The spec is ready
to build behind the development-agent gate.

---

# Revision 1 history (first convergence, 2026-10-27T01:29Z)

### Cross-model review: codex-cli:gpt-6-astra

A real outside (GPT-tier) review ran through the agent's Codex CLI in **all six
rounds**. Every round returned "serious issues", and every finding was handled in
the spec. Gemini was not signed in, so there was no Gemini pass. A clean-door
Anthropic second read was attempted in round 1 and came back degraded (an error),
and it was not retried.

### ELI10 Overview

Instar agents run small timed jobs, such as "check the server is healthy every 5
minutes". Today each run starts a whole AI session that reads about 240,000 tokens
of background instructions, and then just runs one fixed command. Last week Echo
spent about 756 million weighted tokens this way. Almost all of it went on five
jobs whose instructions literally say "run this command exactly as written".

This spec turns 17 of the 37 built-in jobs into plain scripts that need no AI at
all on a normal run. An AI is used only to word a message when something is
seriously wrong, plus one short review a day. A daily practice test feeds every
script a fake broken server, to prove each one can still notice a failure.
Existing agents get the change automatically when they update. A single setting
switches the old behaviour back on. Before anything changes, each job's real
token use is measured for a week, so the saving gets measured rather than guessed.
For the five big jobs, the expected cut is about 95%.

Two of the operator's requests are moved to a second spec, tracked from the day
this one is accepted:
- running the remaining "real agent" jobs on the cheapest model the Instar
  benchmark picks;
- using Jev for the "did someone make a promise?" check.

The reasons are that they cover a small share of the cost, and that review
showed the promise check needs its own careful design.

### Original vs Converged

**Scope narrowed to what the measurement supports.** The first draft also moved
commitment detection to Jev and routed agent jobs by benchmark. Review found four
real problems in the commitment design:
- message ids are per chat, so one cursor skips messages;
- there was no duplicate protection;
- its bookmark doesn't follow a machine handover;
- several machines receive messages.

That job is also switched off on Echo, so its cost was never measured. Both items
moved to a phase-2 spec. That spec is to be registered as a commitment when this
one is accepted.

**Scripts became properly trusted and isolated.** Originally the scheduler would
have run a stored command string through the shell. Now:
- the path is rebuilt from the job name and run with no shell;
- the script file is hash-checked right before every run;
- the environment is a reduced allowlist;
- output is capped;
- a script that fails verification records a failure. It does not quietly start
  an expensive, useless session.

**Two hidden bugs surfaced and are fixed by the design:**
- Script jobs never took the "only one machine runs this" claim.
- The ported feedback scripts recorded failures as successes, because the file
  they reported failures to was never set up for scripts.

**Alerting was rebuilt to follow the constitution**, through six rounds of
correction:
- **Critical problems push immediately and are never muted.** These are a nearly
  full disk and undelivered reminders.
- **Other problems first raise a quiet dashboard note.** The note states only
  what was observed. A problem still there after 6 hours sends one message.
- **One message per run, never one per problem.**
- **Text the tone gate refuses is never sent around it.**
- **"Sent" means delivery was confirmed.** A failed send can't silence an alarm.
- **Critical alarms go out before any file write**, so a full disk can't block its
  own alarm.

**Supervision was honestly re-scoped.** "Tier-1 kept" was false. The spec now
names the change as a deviation from the per-run supervision standard:
deterministic must-fail canaries plus a daily advisory review replace per-run AI
supervision.

### Iteration Summary

| Round | Reviewers who raised design findings | Design findings | Left behind | Main spec changes |
|---|---|---|---|---|
| 1 | all six internal + Codex; gate 3 flags | ~45 | ~10 | full rewrite: loader/trust/no-shell, protocol, claim fix, commitment server pass, phase-2 split of routing |
| 2 | all six + Codex; gate 5 flags | ~22 | ~12 | commitment detection moved to phase 2; heal-then-narrate tables; backoff/breaker |
| 3 | all lenses + Codex; gate 5 flags | ~14 | ~8 | `skipped` semantics, trust fallback = failure, narrator instruction, canary redesign, numbers fixed |
| 4 | all lenses + Codex; gate 2 flags | ~11 | ~6 | 300 s ceiling, per-reason classes, machine-local episode store, deterministic evidence block, must-fail canaries |
| 5 | all lenses + Codex; gate 2 flags | ~12 | ~6 | feature-keyed degradations, no push for recoverable reasons, canary isolation, Tier-1 deviation stated |
| 6 (cap) | security/adversarial 1, integration 2, lessons 1, Codex 3; gate 2 flags | 7 | 5 | push before write on a full disk, git-sync exclusion + atomic writes, 6-hour persistence notice, delivery-confirmed "pushed", baseline bootstrap |

Standards-Conformance Gate: ran every round. Flags by round: 3, 5, 5, 2, 2, 2.
Internal reviewers ran on claude-opus-5-5. In rounds 3–6 the six lenses were run
as three paired reviewers.

### Proportion

This is a Tier 2 change: a scheduler execution path, a trust check, migration to
every agent, and new alerting. It used 6 of 6 rounds, plus one focused check that
the final round's fixes were applied correctly. The spec is about 900 lines.
⚠ The rounds kept finding real design problems through round 6, mostly in the
alerting rules. That is a sign the health-check alerting part is the riskiest
piece to build, and it should get the closest look in code review.

### Left behind

**Accepted at the cap, with reasons:**
- **The 6-hour persistence notice uses elapsed time, not owner heal state.** The
  owners expose no heal state today. When one does, its reason switches to that
  signal.
- **A restart while the disk is full can push a critical disk alarm twice.**
  Accepted: a duplicate alarm is better than a silent one.
- **The canary stops before the actual send.** Delivery is proven by the existing
  delivery instruments.
- **health-check checks only the claim-holding machine's disk**, as it does today.
- **On a completely full disk, no in-server alarm can be delivered**, because the
  send path has to write its own record first. `disk-critical` fires at 5% free so
  the alarm goes out while space remains. A disk-independent alarm path is out of
  scope.
- **A retried push can occasionally arrive twice.** The relay's duplicate filter
  matches identical text within 15 minutes. Accepted.

**Precision items, not iterated:**
- Prune the `job_sessions` table on the same schedule as the ledger.
- Name the exact volume used for the disk check; the spec now says `<stateDir>`.
- Shadow-first versus cascade-first for Jev is a phase-2 decision.
- The supervision pass input is about 51 KB a day; the earlier "17 KB" figure was
  wrong and has been corrected.
- `remediation-actions: []` is a declaration, not something the lint floor proves.

**Queued for phase 2** (one spec, a commitment at acceptance): benchmark routing
for agent-class jobs, lean job context, and event-driven Jev-first commitment
detection.

### Full Findings Catalog

The per-round findings are recorded in the session transcript and summarised in
the Iteration Summary above. Major findings and their resolutions:

| # | Lens | Finding | Resolution |
|---|---|---|---|
| 1 | integration, lessons | Script jobs never took the multi-machine claim (JobScheduler l.917 vs l.950) | Script branch moves below the claim, above session capacity |
| 2 | adversarial, lessons | Python ports record failures as successes (`INSTAR_JOB_FAILURE_FILE` unset for scripts) | Explicit `JOB_RESULT failed` plus exit code, and a new parser |
| 3 | security | Stored `execute.value` ran through `/bin/sh -c` | Path rebuilt from the slug, run with `execFile` and no shell |
| 4 | security, integration | Script jobs had no lock-file trust | `scriptHash`, re-checked before each run; on mismatch the run fails and no session starts |
| 5 | integration | Templates are generated by `getDefaultJobs()` | Changes go there and are regenerated |
| 6 | scalability | No single-flight and no concurrency bound for scripts | Per-slug in-flight guard, cap of 3 with `script-cap` skip and retry, start offsets |
| 7 | lessons, gate | Notify-before-heal, unbounded loops, keyword pre-filter, silent truncation | Reason classes, calm items, 6 h persistence notice, deterministic evidence, bounded inputs |
| 8 | completeness, Codex | Commitment cursor, idempotency, lease and pool design missing | Moved to phase 2 with constraints carried forward |
| 9 | lessons | "Tier-1 kept" was false | Named as a deviation; tier table updated in the same change |
| 10 | adversarial | `degradationSummary` strings are unstable keys | Keyed by `event.feature` (new authed `/health` field) |
| 11 | security | The fallback send could bypass the credential guard | Any gate hold sends only a fixed, reason-id-only sentence |
| 12 | security | A full disk could block its own alarm | Push before write, in-memory dedupe |
| 13 | integration | Episode file would ride git-sync and fail on standbys | Atomic direct write, path excluded from git-sync |
| 14 | Codex | A failed send could suppress an alarm forever | "Pushed" means delivery confirmed, with an idempotency key |
| 15 | Codex | Baseline had no bootstrap | 7 days of prospective attribution plus a backfill with an `unmapped` count |

### Convergence verdict

Stopped at the round cap (round 6, Tier 2). Every design finding raised in round 6
was fixed in the spec. One focused verification pass then checked all seven
fixes:
- Six were confirmed as fixed.
- One exposed a real limit: a completely full disk cannot be reported from inside
  the server. That limit is now stated in the spec and accepted above.
- Three wording contradictions the pass found were corrected. No safety, security or data-loss finding is left open. The items
accepted at the cap are listed under Left behind. The spec is ready for the
operator's review and approval.
