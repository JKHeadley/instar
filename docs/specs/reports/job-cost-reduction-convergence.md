# Convergence Report — Job cost reduction

## Cross-model review: codex-cli:gpt-6-astra

A real outside (GPT-tier) review ran through the agent's Codex CLI in **all six
rounds**. Every round returned "serious issues", and every finding was handled in
the spec. Gemini was not signed in, so there was no Gemini pass. A clean-door
Anthropic second read was attempted in round 1 and came back degraded (an error),
and it was not retried.

## ELI10 Overview

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

## Original vs Converged

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

## Iteration Summary

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

## Proportion

This is a Tier 2 change: a scheduler execution path, a trust check, migration to
every agent, and new alerting. It used 6 of 6 rounds, plus one focused check that
the final round's fixes were applied correctly. The spec is about 900 lines.
⚠ The rounds kept finding real design problems through round 6, mostly in the
alerting rules. That is a sign the health-check alerting part is the riskiest
piece to build, and it should get the closest look in code review.

## Left behind

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

## Full Findings Catalog

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

## Convergence verdict

Stopped at the round cap (round 6, Tier 2). Every design finding raised in round 6
was fixed in the spec. One focused verification pass then checked all seven
fixes:
- Six were confirmed as fixed.
- One exposed a real limit: a completely full disk cannot be reported from inside
  the server. That limit is now stated in the spec and accepted above.
- Three wording contradictions the pass found were corrected. No safety, security or data-loss finding is left open. The items
accepted at the cap are listed under Left behind. The spec is ready for the
operator's review and approval.
