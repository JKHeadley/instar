# ORG-INTENT Drift Detection — ELI16

> Plain-English companion to `ORG-INTENT-DRIFT-DETECTION-SPEC.md`. This is Phase 4 of 4 — the final phase of the org-intent runtime project.

## What's the problem

Phases 1, 2, and 3 do a good job catching individual constraint violations:

- Phase 1: gate blocks any outbound message that contradicts an org constraint at review time.
- Phase 2: agent sees the contract from the start of every session and drafts with it in mind.
- Phase 3: any code can ask the org's tradeoff hierarchy a direct question.

But none of these catch the slow accumulation pattern. Every individual message passes the gate. But week-over-week, the agent has gradually drifted toward optimizing for the wrong objective. By the time anyone notices, the agent has been off-mission for a month.

That's the Klarna failure mode: not a single bad action, but a steady accumulation of borderline-passing actions that collectively miss the organization's actual goal.

## What this change does

We added a deterministic drift digest that samples the gate's recent review history (the last 7 days by default) and looks for two specific patterns:

1. **Concerning trend**: overall block rate is high (default ≥15%). Even if the gate is blocking the bad messages, the *rate* of attempted bad messages is itself a signal.
2. **Rising trend**: the block rate in the second half of the week is meaningfully higher than the first half. Things are getting worse even if the overall rate is still low.

If neither pattern fires (the default case — most weeks), the digest stays silent. If either fires, the digest surfaces a Telegram heads-up with the trend, the most-flagged reviewer dimensions, and one or two suggestions for where to look.

We ship three things:

1. `OrgIntentDriftAnalyzer` — pure function that takes review history + ORG-INTENT.md and produces the trend label. No LLM call. Deterministic.
2. `GET /intent/org/drift?lookbackDays=N` — HTTP route returning the digest on demand.
3. `org-intent-drift-audit.md` — weekly cron job (off by default) that calls the route and sends Telegram when something interesting surfaces.

## How it relates to the earlier phases

- **Phase 1 (gate)**: authority. Blocks individual violations.
- **Phase 2 (session-start)**: agent's working context. Drafts informed by the contract.
- **Phase 3 (tradeoff helper)**: deterministic tie-break for non-reviewer code.
- **Phase 4 (this one)**: long-term pattern detection. Signal only — never blocks anything, never modifies ORG-INTENT.md. Just surfaces the trend.

Together: per-message enforcement + drafting-time awareness + non-reviewer deterministic resolution + long-term drift detection. Four complementary surfaces.

## What you'll notice

- If you have an `ORG-INTENT.md` authored AND you enable the weekly job (it's `enabled: false` by default), you'll get a Telegram heads-up on Monday mornings if drift is rising or concerning. Most weeks stay silent — that's the desired outcome.
- The new endpoint is available to call on demand for the dashboard, an agent question, or any other use case.
- The migrator updates your CLAUDE.md so the agent knows about the new endpoint and the weekly audit.

## What we didn't build

- A way to *fix* the drift autonomously. The audit is a guardian, not a doer. Surfacing the drift is the value; the fix is a human (or operator-level) decision about whether to tighten constraints, loosen them, or change how the agent's autonomy is configured.
- LLM-based pattern detection. The analyzer is pure deterministic logic — block rates, half-window comparison, substring matches. That keeps the surfacing cheap and predictable. Smarter narratives are a future iteration.

## How to roll back

Pure additive. The route can stay unused; the job ships disabled. Code-level revert removes the new file, the new route, and the job template.

## Tests

Three tiers, all passing:

- 11 unit tests pin every branch of the trend decision tree.
- 1 integration test pins graceful degradation (503 when the gate isn't wired).
- 4 E2E lifecycle tests pin the wiring with a real CoherenceGate.

## This is the final phase

The ORG-INTENT runtime project that started with topic 11378 on 2026-05-21 closes with this PR. Four phases, 13 PRs, 50+ tests across three tiers. The file `ORG-INTENT.md` — which had sat on disk for over a year doing nothing — is now actually load-bearing runtime infrastructure.

## Where to look next

- Spec: `docs/specs/ORG-INTENT-DRIFT-DETECTION-SPEC.md`
- Side-effects review: `upgrades/side-effects/org-intent-drift-detection.md`
- Earlier phases: `docs/specs/ORG-INTENT-RUNTIME-GATE-SPEC.md`, `docs/specs/ORG-INTENT-SESSION-START-INJECTION-SPEC.md`, `docs/specs/ORG-INTENT-TRADEOFF-HELPER-SPEC.md`
- Original intent engineering spec: `docs/specs/INTENT-ENGINEERING-SPEC.md`
