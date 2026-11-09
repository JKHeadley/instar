# Convergence Report — Resource-aware placement

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-family external review ran in all six rounds through the agent's own Codex CLI
(`codex exec`, read-only sandbox, the CLI's configured default model `gpt-6-astra`). It was run
directly rather than through `cross-model-review.mjs`, because that script resolves the "capable"
tier to `gpt-5.5`, which this ChatGPT-account Codex refuses ("The 'gpt-5.5' model is not supported
when using Codex with a ChatGPT account") and then reports only `degraded: error`. Filed as
instar feedback `fb-8b562e6d-db5`. The Gemini family was unavailable (`gemini-not-authed`).
Standards-Conformance Gate: `unavailable: the agent server was booting (status warming)` on round
1; the constitution was checked by the lessons-aware/integration reviewers against
`docs/STANDARDS-REGISTRY.md` (Judgment Within Floors, Signal vs. Authority, An Instar Agent Is
Always a Multi-Machine Entity).

## ELI10 Overview

When Echo runs on several computers, it has to choose which computer does each piece of work.
Today it compares raw "busyness" numbers that ignore how big each computer is, and it has no idea
that building an app or running the whole test suite is much heavier than chatting. On 6 November
that let the Mac Studio get so overloaded that Echo's own server kept freezing, while other
computers had room. Justin asked for the agent to choose computers by their size and how busy they
are right now, to keep heavy work off the small Mac Mini, and to make that the default for every
multi-computer agent.

This spec does that. Busyness is compared per core. A computer counts as big enough for heavy work
at 12 cores and 32 GB (today the Studio, M5 Pro and Laptop), and heavy work only goes to a big
computer that has room right now, with fresh numbers. Test runs handed to other computers stop
going to the Mini. Jobs can be marked heavy. And the agent gets a read-only "where would this go?"
preview plus a one-call way to start a background helper session on the chosen computer, so heavy
helper work no longer has to run inside the agent's own process on a busy machine. Each computer
can be overridden one at a time.

The main trade-offs: a heavy job can't run while the Mini is the computer running jobs (it is
skipped and an existing alert says why and how to fix it), and a helper whose start can't be
confirmed is never retried automatically.

## Original vs Converged

- **Load numbers must be fresh.** Originally the design trusted a machine's last load average.
  Reviewers showed that number can be stale or missing (a sparse heartbeat drops it), and a
  missing number scored as "idle". Now only numbers under a minute old count, and a machine with
  no fresh number ranks behind every measured one and never gets heavy work.
- **Same scale as today.** Per-core load is multiplied by 8 so the other weights keep their
  influence, and the spec now says plainly that this changes which target a rebalance picks.
- **Helpers actually carry their task.** Originally "start a placed session" reused the dashboard's
  Telegram-topic path, which carries no task and makes a visible topic per helper. Now a new route
  starts a headless helper on the chosen machine through that machine's own `/sessions/spawn`, so
  its checks and limits always apply, with no Telegram topic.
- **No guessing on failure.** A timeout or crash mid-start is "unconfirmed", never "failed", and is
  never retried automatically; definite refusals now return proper 409 codes so they can be told
  apart. The machine override on the route was removed so nothing bypasses the heavy rules.
- **Bursts are damped.** Each machine advertises how many heavy helpers it just accepted, and the
  deciding machine reserves a slot before sending, so several heavy helpers started together
  don't all land on one machine.
- **Verify peers.** A peer the pool can't size is no longer trusted; skips are audited at most every
  10 minutes.
- **Jobs.** The honest limit (a small machine running jobs can't run heavy jobs) is stated, and the
  existing job-silence alert now explains it in plain words with the two ways to fix it.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security/adversarial/scalability, integration/decisions/lessons, GPT | 15 | 8 | freshness + measured-first, ×8 scale, burst damping, job limit, headless spawn route, verify peers, posture |
| 2 | GPT (5), internal (7) | 9 | 3 | fresh receipt for raw load, single-URL POST + unconfirmed outcome, loopback for self, target-advertised pending, quota rule, helper inputs/results |
| 3 | GPT (3), internal (0) | 3 | 6 | approximate-damping wording, retry rule, raw-load wording |
| 4 | GPT (2), internal (2) | 3 | 4 | no auto-retry, machine override removed, 409 refusal codes on /sessions/spawn |
| 5 | GPT (2), internal (0) | 2 | 3 | exact legacy message formats; accepted-risk section |
| 6 | GPT (1, a wrong claim, fixed in place) | 1 (fixed) | 1 | accepted-risk wording corrected; fleet numbers relabelled |

## Proportion

Tier 2 (fleet-wide default behaviour change to placement): about 330 spec lines; 6 rounds used of
the Tier-2 cap of 6. ⚠ The round count is at the cap; most rounds were driven by the helper-spawn
route's failure semantics, which grew from "reuse the dashboard path" to a new route.

## Left behind

- A helper that started but was never recorded (crash between tmux start and record persistence
  with a lost response) can be started again later; mitigated by the duplicate-name refusal and
  the "check shared side effects first" rule; accepted with durable target-side request records
  not built (recorded in the spec).
- Self-targeted helper spawns pass the rate limiter twice (safe direction).
- tmux's 60-character name cut can make two long names collide (safe direction: second refused).
- The quota gate is not framework-specific (existing behaviour, unchanged here).
- Admission runs dry-run on Echo today, so "the target's admission applies" means "where enforced".
- A small coordinator still runs full verifies in its own slot — instar feedback
  `fb-f291c30d-bbe`.
- The spec-converge Codex reviewer model resolution bug — instar feedback `fb-8b562e6d-db5`.

## Full Findings Catalog

Round 1 (design): unmeasured/stale load scored idle (A1, GPT1, L1) → freshness + measured-first;
per-core weight change (L2) → ×8 reference; stale numeric headroom (GPT2) → fresh only; heavy job
skip forever (A2, GPT3, L3) → documented limit + alert; burst to one machine (A3) → pending damping;
helper path carries no task / needs Telegram (GPT4, L4) → headless spawn route; preview vs decision
divergence (P2, L5) → `answeredBy` + evidence ages; verify peer unknown size (GPT5) → ineligible;
signal/authority classification (GPT6) → table revised; headroom unknown case (L7) → explicit;
small coordinator local verifies (L8) → feedback fb-f291c30d-bbe; CLAUDE.md marker collision (L10)
→ distinct marker. Precision: request rules, command limits, 409 guidance, audit flooding,
mixed-version note, core definition, posture labels.

Round 2 (design): raw-load freshness (GPT1) → receipt within 60 s; pending race (GPT2) → reserve
before send; rebalance claim (GPT3) → corrected; local vs remote validation (GPT4) → loopback for
every target + up-front checks; helper inputs/results (I1) → stated; timeout as failure (I2) →
unconfirmed; pending posture (I5) → target-advertised count. Precision: limiter, sticky best,
quota fallback, outcome labels, job remedy wording.

Round 3 (design): retry duplication (GPT1) → same-name rule; aggregate pending over-claimed (GPT2)
→ approximate, kept to expiry; unknown-core raw freshness (GPT3) → aligned. Internal: 0 design.

Round 4 (design): retry still unsafe + machine override bypass (GPT1-2, I2) → no auto-retry,
override removed; 500 for definite refusals (I1) → 409 codes.

Round 5 (design): absence ≠ never ran (GPT1) → accepted risk; legacy recognition by class name
(GPT2) → exact message formats. Internal: 0 design; precision: reuse existing capacity code,
plain alert text.

Round 6: accepted-risk claim overstated (GPT) → corrected in place; fleet numbers relabelled.

## Convergence verdict

Converged at round 6 (the Tier-2 cap). The internal reviewers found no design issues in rounds 3
and 5; the last external finding was a wrong claim in the accepted-risk wording, corrected in
place, and nothing remaining concerns safety, security or data loss beyond the recorded accepted
risk. Ready for approval.
