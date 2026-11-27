# Convergence Report — Job model routing

## Cross-model review: codex-cli:gpt-6-astra

A real outside (GPT-tier) review ran through the agent's Codex CLI in **all six
rounds**. Every round returned "serious issues", and every finding was handled in
the spec. Gemini was not signed in, so there was no Gemini pass. The clean-door
Anthropic second read (`claude-code:claude-fable-5`) was attempted in round 1 and
came back degraded (an error); it was not retried. That read is disclosure only
and never counts as a cross-model pass.

## ELI10 Overview

After the first spec turns 17 scheduled jobs into plain scripts, 20 jobs still use
an AI, and each one starts a whole AI session (about 240,000 tokens of background)
every time it runs. The biggest is the five-minute "did the agent promise
something?" check. Justin asked for two things: run the jobs that really need a
model on the best-value model the benchmark supports (for example GPT-6 Luna
through Codex, with Claude as the fallback), and use Jev as much as possible, Jev
first and Luna when Jev is unsure. Above both sits his rule that an agent with one
AI provider must still work fully.

This spec does that in the smallest form review would accept:
- **Nine jobs become one small server-side call** instead of a session. That
  includes the five-minute promise check, which keeps its exact question, its
  tracked items and its follow-up, but no longer starts a session. The call goes
  through Instar's existing model router, which already prefers a non-Claude
  subscription and falls back to the default. If the model fails, nothing
  unreviewed is sent.
- **Two jobs become plain scripts**, because the server already writes their text.
- **Four busy session jobs can be pinned to a cheaper framework and model**, but
  only by a reviewed change that cites benchmark results, and only when that
  framework is reachable, has quota and is proven to block a dangerous command.
  Otherwise the job runs exactly as today.
- **Jev filters** the promise check and two expensive Opus sessions, only after
  measured trials, with a continuing audit sample and an off switch that trips by
  itself.

The honest catch: the in-repo benchmark has no GPT-6 results and no job-shaped
tests yet, so no job is pinned until those tests run. Everything new starts dark
on the fleet and in trial mode on development agents.

## Original vs Converged

- **The runtime route picker was cut.** The first draft chose each job's model at
  run time from eight checks over benchmark and production evidence. Review showed
  it served about 6% of sessions and would always pick the default on the fleet
  (its evidence sources are dark there). It became a **pin set by a reviewed PR**
  from benchmark evidence, with a run-time fallback to the default.
- **The promise detector went through three designs and ended as the simplest.**
  Draft 1 built a new detector over the sent-message log. Review found an existing
  server-side detector (`CommitmentSentinel`), so draft 3 widened that one and
  retired the job. Review then showed the two detectors catch different things
  and have different follow-up, and each fix added machinery. The final design
  keeps the job's exact question, store and follow-up, and only moves it from a
  session to a server call, with Jev in front. Nothing downstream changes, so no
  parity proof is needed.
- **Nothing unreviewed is sent.** Draft 1 sent a raw rendering of internal
  reports when a model failed, which could have re-sent a credential. Now a
  failure sends nothing, a held summary raises one attention item on the same
  run, and summaries go through the same credential and tone checks as replies.
- **Grades only veto.** Draft 1 let "the run did something and nobody undid it"
  count as success, which rewards a cheap model that over-acts. Now production
  grades can only take a pin away, and a weekly tool-less comparison against the
  default supplies a check that does not depend on the operator noticing.
- **Codex must prove it blocks a dangerous command**, with a harmless test command
  and a marker file, not just show hook entries in a config file.
- **Jev's audit and screens were made real.** The audit share has a stated value,
  the screens need settled outcomes within a horizon, and the go-live switches are
  code defaults so a PR reaches every agent.
- **Staging.** Every new piece rides the development-agent gate; the fleet gets
  each piece by its own PR; a test-agent rung precedes development agents for pins.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | all six + codex | ~38 | ~10 | Major rewrite: Telegram history source, async claimed passes, nothing sent on failure, unknown-is-ineligible, grades rework, dev-gating |
| 2 | all six + codex | ~19 | ~12 | Resolver cut to PR-set pins; pre-gate narrowed to 2 jobs; reply checkpoint for passes; deny canary; per-path caps |
| 3 | sec, scal, adv, integ, dc, lessons + codex | ~11 | ~10 | Discovered `CommitmentSentinel`; durable coverage; canary harmless + marker; breaker PR-only |
| 4 | all six + codex | ~13 | ~8 | Sentinel v2 widened and flagged; outcome link; comparison before retirement |
| 5 | adv, scal, dc, integ, lessons + codex (security clean) | ~14 | ~9 | Replaced with the simplest design: commitment-detection as a pass with unchanged output |
| 6 | scal, adv, integ, dc, lessons + codex (security clean) | 10 (all fixed in the spec at the cap) | ~10 | Time limit, start marks, rollback dedupe, audit value, settled-outcome screen, code-default switches, per-promise keys, ingest amendment, delivery guarantee |

Standards-Conformance Gate, per round:
- Round 1: ran (6 flags)
- Round 2: ran (3 flags)
- Round 3: ran (3 flags)
- Round 4: ran (3 flags)
- Round 5: ran (2 flags)
- Round 6: ran (2 flags: Framework-Agnostic, tracked by a commitment; Verify the State, where effect presence is used only as a veto)

Internal reviewers ran as Claude subagents on the session model (`claude-opus-5-5`) in every round.

## Proportion

⚠ Tier 2 (an 860-line spec over the job runner, the promise path and model
routing), 6 rounds of 6. That is at the cap. Most of the cost went on the promise
detector, which was redesigned three times before review pointed at the smallest
version. The lesson: start from "keep the output, change only the executor"
before designing a replacement.

## Left behind

Round 6 design findings, **fixed in the spec at the cap without a seventh round**
(none affects anything this build run switches on: every one is behind a
development-agent gate or an evidence-gated later PR):
- Commitment pass time limit and slot use (expected duration 4 min, chunks sized
  to the time budget, cancellation counts as degraded). Scalability.
- First-run marks could replay weeks of stale promises; now the later of the old
  job's last run start and one hour ago. Integration.
- Rollback could replay and duplicate actions; now the pass advances the old
  bookmark and the session template sends the same key. Adversarial, integration,
  codex.
- Jev audit share had no value; now 0.05, at least 5 rows a week.
  Decision-completeness.
- Jev drop screen and breaker relied on a rarely produced "completed" outcome; now
  the referee's verdict plus at least 10 settled outcomes within 14 days, and the
  breaker trips on audit disagreement. Adversarial, integration, lessons.
- Go-live switches written into config could not be flipped by PR; now code
  defaults. Decision-completeness.
- Two promises in one message shared one key; now one key per promise. Codex.
- Spec 1 §7's event-driven ingest requirement is amended explicitly, with reasons.
  Codex.
- Delivery guarantee stated honestly: at most once per `runId`, uncertain sends
  held by the origin outbox. Codex.

After round 6, the tag writer refused the spec until its `## Maturation plan`
used the required fields (test-agent-live, dev-agent-live, fleet, graduation
criterion, dark-window). The section was restated in that form from content
already in §11–§12; no design changed.

Precision items, not iterated:
- Untrusted model-written action text reaches evolution-overdue-check, which is
  unchanged from today; wrap it as quoted data when that template is next touched.
- A per-topic daily write ceiling for the commitment pass (exposure unchanged from
  today).
- evolution-overdue-check's template contradicts itself ("report only" vs "attempt
  to complete"); worth fixing separately.
- The `externalKey` lookup is a linear scan; fine at today's volume.
- Relationship-maintenance's gather goes to Codex where Codex routing is active;
  the fleet PR should name this beside the Jev egress.
- A held forward that is later recovered is not written to the Telegram log; this
  affects the old job and the pass equally.
- Claude Code is the reference framework for gate parity; Gemini / pi / Grok
  pinning is tracked by a commitment.

## Full Findings Catalog

Per-round findings, with the reviewer, class and resolution, are in the round
notes kept with this run. The material ones are summarised above under "Original
vs Converged" and "Left behind". Round-by-round design themes:

- **R1:** Stop-hook source was the wrong text and dark on the fleet (adv, integ,
  lessons); a credential could be re-sent by the fallback (sec, adv); "right"
  rewarded doing nothing (adv); unknown read as all-clear (lessons); synchronous
  pass route (scal); unbound pass route (integ); real data in bench fixtures (dc);
  fleet staging (dc); codex: stickiness bypassed veto, recovery contract, selected
  vs executed model.
- **R2:** job notifications skip the credential and tone checks (sec); Jev egress
  of conversation text (sec); hook evidence from the wrong hook (lessons); resolver
  out of proportion (lessons); pool log split (integ); retire gate counted
  processed not classified (adv, scal); codex: bootstrap, labels are agreement.
- **R3:** existing CommitmentSentinel (integ); in-memory counters lost on restart
  (scal, adv, lessons); one-promise-per-topic merged distinct promises (adv,
  codex); breaker reset by the agent itself (dc); deny canary proved notice not
  block (sec).
- **R4:** sentinel is not a duplicate of the job (dc, lessons, codex); outcome
  grade did not exist (adv, lessons); batched call had no per-exchange answer
  (scal); pool log split again (integ).
- **R5:** no delivery link; beacon flood; store growth; overdue gate cannot see
  commitments; double follow-up during overlap (adv, lessons, scal, integ, dc,
  codex) — resolved by replacing the design.
- **R6:** see "Left behind".

## Convergence verdict

Converged at the round cap (round 6 of 6). The final round's design findings were
all fixed in the spec at the cap and are listed under "Left behind"; none concerns
safety, security or data loss in this build run, because every affected switch is
dark on the fleet, in shadow on development agents, or flipped only by a later PR
that quotes its numbers. Open questions: none. The spec is ready for review and
approval.

## 2026-10-27 audit amendment

Justin added a universal requirement: Jev and every other LLM call must be
benchmarkable, attributable and reviewable in bulk for accuracy and cost. A
GPT-6 Astra review identified gaps in this spec's earlier per-run accounting:
call-attempt identity, prompt version, actual model, independent outcome
grading, unknown denominators and bulk joins were not mandatory on every path.
The spec and ELI16 now make the audit adapter and its three-tier wiring tests a
prerequisite for each new call family. This is an amendment after the six-round
convergence above, not a claim that the amended design has already been built
or certified. Existing callsites outside this spec require a separate coverage
audit and retrofit.
