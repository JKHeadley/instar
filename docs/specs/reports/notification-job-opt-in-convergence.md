# Convergence Report — Per-job notification opt-in for Quiet by Default

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier pass ran on all three rounds. The Gemini family was unavailable (`gemini-not-authed`). The Anthropic clean-door family was not run.

## ELI10 Overview

Scheduled job reports stay out of chat by default, and the only switch covered every job. This spec adds a switch per job, so the operator can hear from one job and not the others. It also has the agent offer that choice when it creates a job that reports to the operator.

The hard part is trust. The job name that arrives with a report today is written by the sender, so it cannot unlock anything. The design trusts only a name the server worked out itself, and seals it into the signed message record so a restart or another machine reaches the same answer.

The main tradeoff: this reuses the operator proof the category switch already has, which shows the operator spoke recently, not that they said yes. And because agents usually create jobs by writing a file, the prompt to ask lives in their instructions, not in a server response.

## Original vs Converged

- Originally any session with a `jobSlug` counted as that job. Review found that anyone who can spawn a session can name any job, so identity now also needs the scheduler's own mark.
- Originally an opted-in report stayed in whatever topic the job addressed. Review found that would let a misbehaving job post anywhere after one yes, including to outsiders through the browser route. Now only the topic where the operator said yes keeps a report out of the Attention topic.
- Originally the spec said the agent "never grants itself push". Review showed the proof cannot establish that, so the claim is withdrawn and the limit is stated.
- Originally the ask was treated as mostly a server response. Review found no agent reads that response on the real path, so the always-loaded instruction line and the skill now carry it.
- Added: a job written seconds ago is found; turning a job off never needs the job to exist; a job on another machine is found; a typo in the job file answers instead of crashing the server; older machines that upgrade in place still receive the choice; advice and confirmations say what will really happen in observation mode and under category push.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, decision-completeness, lessons-aware, codex | 19 | 14 | Identity needs the scheduler mark; topic binding; route refresh, peers and unknown-slug rules; slow retry; truthful advice; ask moved to core instructions |
| 2 | adversarial, integration, codex | 6 | 6 | Guarded async route; truthful destination text in skill and dashboard; branch on origin machine |
| 3 | codex, second-pass reviewer | 2 | 3 | Observation-mode confirmation text; wording |

Standards-Conformance Gate: round 1 `unavailable: server booting (503)`; round 2 not re-run; round 3 ran (0 flags across the 3 report rows it returned).

Reviewer models: internal reviews ran as subagents on the session model (Opus 5.5), combined into grouped passes rather than six separate agents, sized to a Tier-1 change.

## Proportion

Tier 1, about 15 source files and 300 lines, 3 rounds of a 3-round cap. ⚠ High for Tier 1: this change widens a delivery gate and crosses the mesh, and rounds 1 and 2 each found a real defect, including a server crash in the first fix.

## Left behind

- A report sealed for one topic delivers there even if the operator moves the binding to another topic before delivery. Accepted: one in-flight send, needs a fresh operator confirmation in that window. Codex raised this in rounds 2 and 3 as design; accepted at the cap as out of proportion.
- With no Attention topic, or on the non-origin adapter path, an opted-in report stays where it was addressed, as for every category. Accepted: closing it needs seal-time state in `decide()`.
- Operator proof does not establish a yes, on this route and the category route. Queued to the feedback queue as a consent-bound ask.
- Hand-written `jobs.json` gets instruction, not enforcement. Queued to the feedback queue as a scheduler "unasked" item.
- Backup: `config.json` and `notification-preferences.json` are outside the backup set, as for categories. A restored lone machine goes quiet.
- A machine paired after a choice gets it only on the next change, as for categories.
- `skills/instar-scheduler/SKILL.md` documents a `/jobs/reload` route that does not exist. Pre-existing; queued to the feedback queue.
- The dashboard job row shows unticked when the category pushes that job. The message on change is truthful.

## Full Findings Catalog

Round 1, security and adversarial: spawn route can name a job (fixed); opt-in reaches any topic (fixed by topic binding); proof shows speech, not consent (accepted, stated); stale opt-ins cannot be cleared (fixed for `enabled:false`, recreate inherits by decision); lint plan fails (fixed); fact 5 overstated (corrected); stalled intent on quiet upgrade (fixed by slow retry).

Round 1, integration and lessons: ask does not reach the agent (moved to core instructions and skill; enforcement left behind); immediate yes 404s (fixed by refresh); yes can deliver nothing, or duplicates (decided and documented); machine-local job list (pool read added); stranded intents (slow retry); untrue in observation mode (advice and outcome fixed); message id lookup missing (named in skill and advice); backup (left behind); lint (fixed); legacy core line migration (added).

Round 1, codex: shared slug identity (decided: same slug, same job); revocation lag (stated); advice versus category push (fixed).

Round 2, internal: unguarded `refreshJobs` could exit the server (fixed, tested); "reports arrive in that topic" false for scheduler notices (corrected, confirmation names the place); topic limit absent with no hub (scoped and left behind); dashboard text untruthful (uses the route message). Precision: dev-agent resolver in the CLI (fixed); peer read cap and timeout (fixed); dark peers on dashboard (note added); test gaps (peer paths tested); churn title (reworded).

Round 2, codex: peer record branch (fixed on `originMachineId`, tested); seal versus delivery topic (left behind).

Round 3, codex: seal versus delivery topic again (left behind at the cap); replace semantics (stated); consent wording (corrected).

Round 3, second-pass reviewer: opt-in confirmation false in observation mode (fixed, tested); stale figures in the artifact (corrected).

## Convergence verdict

Stopped at the Tier-1 cap of 3 rounds, with round 3 still finding one false statement, now fixed. The one remaining design finding is an in-flight timing window, accepted above. It is not a safety finding that blocks: it needs a fresh operator action inside one send, and stays within the push budget. Not approved: `approved: true` is the operator's step and has not been applied.
