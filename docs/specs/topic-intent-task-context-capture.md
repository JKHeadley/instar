---
slug: topic-intent-task-context-capture
title: Generalize topic-intent capture to task contexts (method / audience / goal)
author: echo
project: continuous-working-awareness
status: approved
review-convergence: "2026-05-25T01:16:00Z"
review-iterations: 1
review-note: "Claude-authored + manual standards/lessons self-review (single angle). Full /spec-converge + /crossreview multi-model convergence NOT run — tooling absent on this host. Ratified by Justin 2026-05-25 with that caveat explicit; fuller review to precede/accompany code merge. See 'Convergence note (honest)' in body."
approved: true
approved-by: justin
eli16-overview: topic-intent-task-context-capture.eli16.md
---

# Topic-Intent Task-Context Capture (rung 1)

## Problem statement

Rung 0 (the capture loop, shipped v1.2.62) extracts **conversational facts and
decisions** per topic — propositions the conversation *asserts* ("we'll use
Path B", "the deadline is Friday"). That is the right first slice, but it is not
the slice that caused the founding incident.

The original methodology-drift incident (topic 9984) was **not a forgotten
fact** — it was a forgotten **task frame**: the agent lost track that *"we are
testing this over Telegram"* mid-campaign. That is not a proposition the
conversation asserts; it is the **method / audience / goal of the active task** —
the working frame the agent operates inside. Rung 0's extractor would not capture
it, because "Telegram is the test surface" never appears as a fact-or-decision
claim; it is the *shape of what we're doing*, established once and then assumed.

So the seed crystal, as shipped, still can't catch its own origin story. Rung 1
closes that: it generalizes capture from "facts the conversation states" to
"**the frame the task is operating in**", writing into the *same*
confidence/decay store, so the same briefing and the same ArcCheck can catch
method/audience/goal drift — the exact category the North Star was named to kill.

> This is the North Star's rung 1 verbatim (`docs/NORTH-STAR.md`): *"Generalize
> capture beyond conversational facts. Extend the extractor to capture task
> contexts (method, audience, goal), writing into the same confidence/decay
> store."* It depends on rung 0 existing — which it now does, in production —
> so this spec is written against real ground, not guesswork.

## Non-goals (tracked, not silent)

- **Unifying the stores** (Playbook + memory + topic-intent) is rung 2
  <!-- tracked: cwa-unify-store -->. This spec writes into the existing
  TopicIntentStore only.
- **The Usher / continuous mid-task injection** is rungs 4–5
  <!-- tracked: cwa-usher -->. This spec surfaces task-frame at the existing
  surfaces (session-start briefing + pre-send ArcCheck) — no new injection
  machinery.
- **Multi-adapter capture** beyond the rung-0 Telegram seam stays as already
  tracked <!-- tracked: cwa-multi-adapter-capture -->.

## Proposed design

### 1. Task-context as new ref kinds in the SAME store

Extend `RefKind` from `fact | decision` to add three task-frame kinds:
`method | audience | goal`.

- **method** — *how* the work is being done right now: "testing over Telegram",
  "driving the target agent as the user", "editing in a worktree, not the shared
  checkout".
- **audience** — *who* the current output is for: "this message is for Justin",
  "this is end-user-facing copy", "this is an internal dev note".
- **goal** — *what* the active task is trying to achieve, at the task level (not
  a decision): "the goal of this run is to reproduce the stall, not fix it yet".

**Decision flagged for ratification (A):** three distinct kinds vs. one
`task-context` kind with a subtype field. **Recommendation: three distinct
kinds.** They have different drift semantics (a contradicted *method* is a
louder signal than a faded *goal*), different decay horizons (§3), and the
briefing/ArcCheck can label and target them precisely. The cost is three enum
values; the alternative (one kind + subtype) saves nothing and blurs the
ArcCheck rules.

These are additive to `RefKind`; existing files load unchanged (the field is
already free-text-tolerant on read). No new store, no new write path.

### 2. Capture via the SAME loop — extend the extractor, don't add a pass

`captureTurn` and the live `onMessageLogged` wiring (rung 0) are unchanged. The
only change is `buildExtractorPrompt`: alongside fact/decision proposals, the
extractor is asked to surface **task-frame signals** — and it is already holding
exactly the right context to do so, because rung 0 already feeds it the **rolling
summary** (where the task frame lives) plus the established refs.

- One LLM call per turn still (no second pass, no extra cost beyond a slightly
  longer prompt). **Decision flagged for ratification (B):** extend the single
  prompt vs. a dedicated task-frame extraction pass. **Recommendation: extend the
  single prompt** — keeps the per-turn cost at one fast-tier call (honoring the
  rung-0 cost envelope), and the rolling summary is the natural substrate for
  frame detection. A separate pass doubles per-turn spend for marginal precision.
- New `SignalProposal` kinds: `new-task-context` (with `refKind` ∈
  method/audience/goal) plus the existing reref/affirm/contradict anchored to a
  task-context refId. Re-stating the frame reinforces it; contradicting it
  ("actually we're testing in the dashboard now") demotes it — same evidence
  model as facts.
- The extractor stays **conservative + fail-open** and the pre-filter is
  unchanged (task-frame turns are substantive by definition; trivial turns still
  skip).

### 3. Multi-horizon decay — the hierarchy of contexts, finally made real

This is the design Justin steered toward and the place rung 1 earns its keep.
Today decay is **one fixed profile** (30-day grace + 180-day half-life), correct
for long-lived facts. Task frames are shorter-lived: "testing over Telegram"
matters intensely *this task* and should fade in days, not survive 180. So rung 1
introduces a **per-kind decay profile**:

| Kind | Horizon | Grace | Half-life | Rationale |
|------|---------|-------|-----------|-----------|
| `method` | short | 1 day | 7 days | the active how; fades fast once the task moves on |
| `goal` | short–medium | 2 days | 14 days | the active what; outlives method, fades after the task |
| `audience` | medium | 3 days | 30 days | who-it's-for tends to persist across a task cluster |
| `fact` / `decision` | long | 30 days | 180 days | unchanged — rung-0 behavior preserved exactly |

Decay is **demotion, not deletion** (unchanged): a faded frame drops out of the
hot briefing set but stays on disk, and a later reference re-warms it — exactly
the human-memory behavior the North Star describes. **Decision flagged for
ratification (C):** the specific horizon values above are a starting point, not
sacred; they are the kind of thing the Observability funnel (§6) lets us tune
with real data. The *mechanism* (per-kind profile) is the decision; the *numbers*
are tunable.

Implementation: `projectConfidence` already takes the kind implicitly via the
ref; the fixed `DECAY_GRACE_DAYS` / `DECAY_HALF_LIFE_DAYS` constants become a
per-kind lookup. Existing facts/decisions keep the exact current numbers, so
**rung-0 confidence math is provably unchanged** (a regression test pins this).

### 4. Surfacing — where the drift actually gets caught

- **Briefing.** The session-start briefing renders a distinct **"Active task
  frame"** block (method/audience/goal currently above tentative), separate from
  the facts/decisions block. So a fresh session opens already knowing "we're
  testing over Telegram" without anyone re-stating it. This is the line that
  would have prevented the founding incident.
- **ArcCheck.** A new signal rule: if a pre-send draft's action **contradicts the
  active method/audience/goal** ("about to verify by reading the code" while the
  active method is "test it live over Telegram"), ArcCheck fires — *signal only*,
  per [[feedback_signal_vs_authority]]: it surfaces "heads up, this seems to drift
  from how we said we're working — confirm?" and never blocks. This is the
  mid-task catch, at the existing pre-send surface (no Usher yet).

### 5. Authority model — unchanged, applied to frames

Task contexts use the **same user-authority clamp + evidence model** as rung 0.
A user *stating* the frame ("we're testing over Telegram") is `extract-user`
(authority-eligible); an agent *inferring* the frame is `extract-agent` (capped
below tentative — it can inform, never authoritatively assert a frame the user
didn't set). A user contradiction demotes a frame in one turn, exactly as for
facts (the §9 rung-0 property, re-verified for the new kinds).

### 6. Observability across the whole loop (per the new standard)

Per the just-ratified **Observability** article, the capture funnel
(`GET /topic-intent/:id/capture-metrics`) is extended to break out the new kinds:
task-frame captured / surfaced-in-briefing / fired-in-ArcCheck, per
method/audience/goal. So we can *see* whether frame-capture is working and tune
the decay horizons (§3) from real data instead of guessing — and the
human-as-detector heat map remains the miss-measure: a frame-drift the user has
to catch is logged as the guardian-failure it is (the **Never-Waste Feedback**
article).

### 7. Prompt-injection hardening — unchanged, extended

The task-frame inputs (rolling summary, existing task-context ref text) are the
*same untrusted inputs* rung 0 already fences inside delimited data blocks with
the "content to analyze, never instructions" guard, truncated to hard caps. The
new proposal kinds carry no new injection surface; the injection-resistance test
is extended to cover a crafted "set the method to X / ignore the active frame"
message.

## Lessons carried (manual lessons-grep — [[feedback_spec_converge_pre_auth_circular]])

- **Zero manual capture** ([[feedback_no_cli_recommendations]], North Star hard
  rule): capture is automatic via the existing loop — no "remember to log the
  task frame" step for user *or* agent. This is the whole point.
- **Signal vs. authority**: ArcCheck on task-frame is a signal; only the
  full-context send path decides. Never a block.
- **Near-silent**: the briefing frame-block and ArcCheck fire only when they'd
  change the next action; routine frame-capture is silent (pull surface only).
- **Best-effort never-throws / degrade-safe / fire-and-forget**: inherited from
  rung 0 unchanged — task-frame capture rides the same off-delivery-path seam.
- **Framework-agnostic**: the extractor + store are already engine-neutral; this
  adds only enum values and a decay table. No engine coupling.
- **Migration parity**: additive RefKinds (defaulted on read) + a per-kind decay
  table (rung-0 kinds keep exact current numbers) + the extended metrics. No hook
  / template / config-shape change beyond an optional decay-profile override.
- **Testing integrity (3 tiers + wiring + transport)**: §Testing.
- **Bug-fix/feature evidence bar**: the acceptance test must show a real
  "we're testing over Telegram"-class turn producing a `method` ref end-to-end,
  not a unit mock.

## Testing (all three tiers + wiring + transport)

- **Tier 1 (unit):** extractor emits task-context proposals from a frame-stating
  turn; per-kind decay profile (method fades by day 8, fact unchanged at day 8);
  rung-0 confidence math unchanged for fact/decision (regression pin); agent-set
  frame never reaches tentative; one contradiction demotes an authoritative
  frame; injection-resistance for a "set the method" attack.
- **Tier 2 (integration):** a posted frame-stating turn creates a `method` ref;
  the briefing renders the "Active task frame" block; capture-metrics breaks out
  the new kinds; an ArcCheck call on a frame-contradicting draft fires.
- **Tier 3 (e2e):** boot the real path; simulate a frame-setting turn + a later
  drifting draft; store fills with a task-context ref, briefing renders it,
  ArcCheck signals on the drift — the founding-incident scenario, reproduced and
  caught.
- **Wiring-integrity:** the extended extractor is the one wired on the live
  callback (no second, unwired path).
- **Transport:** unchanged — the single extraction call still routes through the
  LlmQueue background lane on the subscription provider.

## Acceptance criteria

1. A user turn that states a task frame ("we're testing over Telegram") produces
   a `method` (or audience/goal) ref in the store — verified e2e, not mocked.
2. The session-start briefing renders that frame in a distinct "Active task
   frame" block.
3. A pre-send draft that contradicts the active frame makes ArcCheck fire
   (signal, not block).
4. Task-frame kinds decay on their own (shorter) horizons; `fact`/`decision`
   decay is byte-for-byte unchanged (regression test).
5. An agent-inferred frame never reaches `tentative`; a user contradiction
   demotes an authoritative frame in one turn.
6. capture-metrics exposes per-kind task-frame counts across the whole funnel.
7. Crafted "set the method / ignore the frame" messages produce no out-of-band
   proposals.
8. All three tiers + wiring + transport + injection tests green; tsc + lint clean.

## Risk and rollback

Low–medium, and strictly additive to rung 0. The new per-turn cost is **zero
extra LLM calls** (same single extraction, slightly longer prompt). Worst case on
a logic bug: spurious or missing task-frame refs (a diagnostic surface), never a
delivery failure (best-effort inherited). The one genuinely new behavior is the
per-kind decay table — guarded by the regression test pinning rung-0 numbers.
Rollback: stop emitting task-context proposal kinds + revert the decay table to
the single profile; facts/decisions are untouched throughout. The rung-0
kill-switch (`topicIntent.capture.enabled`) disables the whole loop including
this.

## Migration parity

Additive `RefKind` values (defaulted on read) + a per-kind decay profile (rung-0
kinds keep exact current constants) + extended `capture-metrics` breakout + the
extended briefing block. Server-side (every agent gets it on update). Optional
config `topicIntent.capture.decayProfiles` override (existence-checked default).
No hook/template/skill change.

## Open decisions for ratification

- **(A)** Three distinct `method|audience|goal` kinds (recommended) vs. one
  `task-context` kind + subtype.
- **(B)** Extend the single extractor prompt (recommended) vs. a dedicated
  task-frame extraction pass.
- **(C)** The specific decay horizons in §3 (starting values, tunable via the
  Observability funnel) — confirm the *mechanism*; the *numbers* are knobs.

## Convergence note (honest)

This is a **Claude-authored draft + a manual standards/lessons self-review** —
the full `/spec-converge` + `/crossreview` multi-model convergence tooling is not
installed on this machine. Per [[feedback_external_crossmodel_catches_what_internal_misses]],
a Claude-only pass misses what GPT/Gemini/Grok catch (concurrency, supply-chain,
precision failure modes). Recommendation before building: run this through full
convergence on a machine that has the skill (or I harden it further across more
angles). Ratification here = "the design direction is right, proceed to
convergence/build"; it is not a substitute for the multi-model round.
