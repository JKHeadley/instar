# Jev first by default: build brief

Justin, topic 95267, 2026-11-03 17:37 PST (full text):

> I feel like we are REALLY dropping the ball with Jev here. It has HUGE advantages with speed and cost, and it has excellent accuracy with confidence in its answers, which means it should be able to plug into MANY of the current frequent and small decisions in Instar jobs/sentinels/tasks/etc and take a portion of the work, and then pass off to an appropriate LLM (based on Instar benchmark results) when it is not confident in its answer. Each scenario should be treated just like all LLM decisions where the full context is logged so that it can regularly be reviewed and tuned to be more accurate and take a higher percentage of the work.
>
> In addition, we should regularly be finding more areas in Instar where we can leverage Jev based on our ongoing and evolving understanding of how to use it effectively.

This repeats his standing rule of 2026-09-26 (`.instar/agent-memory/jev-default-cascade-to-luna.md`). It was never applied to existing checks.

## The mistake not to repeat

Reviews asked "does this fix something broken?" and "is there a failing consumer?". A working but expensive check can never pass that test. The reason to move a decision is the saving. A candidate is rejected only for measured unsuitability, for example it writes free text and has no decision inside it, or it fails its bar after question and context tuning.

## Baseline (7 days to 2026-11-03)

482M tokens on internal checks; Jev 4.3M (0.9%); about 0 big-model tokens saved. Largest by tokens: MessagingToneGate 116M, UnjustifiedStopGate 60M, TopicIntentArcCheck 59M, completion-claim-verify 56M, TopicIntentExtractor 49M, SessionActivitySentinel 34M, PromptGate 32M, telegram-origin-recovery 12M, SessionWatchdog 9M, MessageSentinel 7M. Re-read live: `GET /metrics/features?sinceHours=168`.

## Read first

- `src/core/JevCascade.ts`: existing shared helper. `src/threadline/PeerUserMeantJudge.ts`: the most complete Jev-first example. `src/core/IntelligenceRouter.ts`, `src/core/DecisionQualityRecorderImpl.ts`, `src/data/benchmarkPredictions.json`.
- `docs/research/jev/README.md`, `decision-point-fit.md`, `reviews/2026-11-02.md`, `harness/commitment-replay/`.
- `.instar/agent-memory/jev-measured-results.md` and `jev-as-controller-not-classifier.md`. These contain the design rules: an explicit "cannot tell" option, per-question direction-aware bands, full state rather than an excerpt, and suspect our context first when Jev is confidently wrong.
- MEMORY.md "Every Jev and LLM call must support bulk quality review" (Justin, 2026-10-27).

Note: this agent home's checkout is stale. Work from a fresh worktree of main (`instar worktree create`).

## Phase 1: ranked list and replays (no product code; first report by 20:00 PST 2026-11-03)

1. Write `docs/research/jev/jev-first-inventory.md`, covering every LLM decision point in jobs, sentinels, gates and tasks: tokens and calls per week, p50, current model, the decision it makes, what happens when it is wrong, whether a hard block depends on it, and what past evidence we hold.
2. Split each into: fully Jev-shaped; a Jev decision in front of generation (for example "is there anything new to summarise?", which skips the writer); or not suitable, with a measured reason.
3. Estimate the saving for each: share Jev would settle x that check's weekly tokens. Say which estimates are measured and which assumed.
4. Run real replays on the top candidates. Size samples to the prespecified quality bar and track actual spend; do not stop at an arbitrary dollar estimate. Pin `jev-1.13.0`. Set the bar before each run. While the machine is CPU-saturated, limit parallel heavy tests so existing work remains responsive.
5. Send one plain-language message to Telegram topic 95267 (`.claude/scripts/telegram-reply.sh 95267`): the ranked list, measured share and accuracy, and what goes first. No file paths, setting names or internal ids.

The prompt-injection check and the self-stop check were marked do-not-move as Jev-only judges. Under the cascade, re-measure them: can Jev settle a confident safe share with no misses in that direction? Keep the old verdict if not.

## Phase 2: the shared path (via /spec-converge, then /instar-dev)

One decision-point seam any check can adopt with little code:

- Each decision point declares: stable id, prompt/question version, a per-question band, and its handoff model.
- Handoff model comes from Instar benchmark results for that task, not a hard-coded Luna. If no benchmark exists, name the gap and fall back to the model the check uses today.
- Flow: Jev; if confident, settle; if unsure, slow, down or erroring, hand off. A small random audit share of confident answers is also sent to the handoff model.
- **Rule 118 (one provider):** with no Jev key, the decision goes straight to the handoff model and is fully delivered. It must not switch off.
- **Log per decision (bulk review):** full context with secrets scrubbed, stored locally with bounded retention, plus question version, Jev probabilities, latency, whether it was handed off and why, handoff verdict, final verdict, model and cost, and a link to later outcome evidence or a named grading gap. Reuse the existing decision-quality and Observable Intelligence records and do not build a parallel store unless they cannot hold this.
- **Promotion is per decision point:** shadow, then live. Each has a pre-set bar on the real rows. Checks a hard block depends on need zero confident misses in the direction that lets a violation through, a large enough sample stated in advance, and an unsure-goes-to-full-check path. The credential wall stays as it is.
- Reversible setting per decision point, dev-gated: live on Echo, dark on the fleet. Migration Parity and Agent Awareness standards apply.
- Add a read surface showing per decision point: share settled by Jev, handoff rate, audit disagreement, tokens saved. This feeds the headline number in the review job.

## Phase 3: first wave

Convert the top candidates from Phase 1 onto the seam in shadow and graduate the ones that meet their bar on Echo. Report each graduation in topic 95267 with its number. Then keep going down the list; do not stop at one.

## Phase 4: make it continuing

Update the review job `.instar/jobs/user/jev-integration-review.md` so each run: reads the read surface, tunes the worst decision point (reads audit disagreements, changes the question, context or band, re-measures), moves at least one more decision point a stage forward, and scans for new LLM call sites and new ideas from what we have learned. Remove any wording that requires a candidate to fix something broken. Do it in the same PR-free way the file is kept today: it is excluded from git and lives on this machine.

## Constraints

- Do not edit constitution files; if you think one needs changing, stop that part and tell the desk.
- Do not change behaviour on fleet agents.
- Every number you report must come from a run you made. Set bars in advance; if you pick a threshold after seeing the data, it does not count until re-tested on fresh rows.
- If a usage limit or other block stops you, say so in topic 95267 immediately. A builder died silently on this exact track on 26 Oct.
- Bugs you find outside this scope go to `POST /feedback`, not into this build.
