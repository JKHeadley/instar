# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

**Fixed a runaway credit-burn bug: LLM call loops no longer keep hammering the
provider after you hit a usage or spend limit.**

Instar runs small background LLM calls to watch your sessions (for example, the
per-tick check that detects when a session is blocked on a prompt). Until now,
if one of those calls came back with a usage/rate/spend-limit error, the loop
swallowed the error and tried again on the very next tick — with no backoff. If
your account had auto-reload turned on, each retry refueled and re-burned. A
real agent in the wild burned $452 of $455 in usage credits this way over a
couple of days before anyone noticed.

There is now an **account-global circuit breaker** in front of every internal
LLM call. The moment the provider reports a usage/rate/spend limit, the breaker
opens and *all* background LLM-backed work pauses — without spawning another
`claude` subprocess, so it costs nothing while paused. After a cool-down window
(15 minutes by default) it sends exactly one quiet probe; if the limit has
lifted it closes and resumes automatically, and if not it waits another window.
It is wired at the single provider-construction chokepoint, so every feature —
current and future — is covered with no per-feature work.

This is reactive (it listens to the provider's own "you're over limit" signal)
and complements the existing volume-based burn-detection, which reacts to
statistical token-share over a longer window.

**Failure-Learning Loop — revert ingestion source.** Second automatic feed for
the Failure-Learning Loop: the **revert source** (spec
`docs/specs/FAILURE-LEARNING-INGESTION-SOURCES-SPEC.md` §3.2). This completes
the approved "CI + reverts" first slice — the CI source shipped already; this
adds detection of *undone changes*. Off by default
(`monitoring.failureLearning.sources.revert`); no change when off.

When a change is reverted, that's strong evidence the original was bad enough to
pull. The revert source scans recent commits for `Revert "…"` and records it —
but it is careful, because commit messages are attacker-authorable: it will only
mark an existing recorded failure as resolved if the revert genuinely reverses
that commit (the reverted commit is real and reachable AND the revert's diff
actually touches the same files), and the match is on both the feature and the
exact commit — so a hand-written "this reverts X" can't quietly close someone
else's record. A revert that fails those checks can at most file a low-confidence
note, never close anything. A revert-of-a-revert (a re-land) is ignored — it
isn't a failure.

## What to Tell Your User

Your agent can no longer burn through your credits by repeatedly calling the
model after you've hit a usage or spend limit. The instant the provider says
you're over your limit, background model work pauses on its own, costs nothing
while paused, and quietly resumes once the limit lifts. This is on by default —
no setup needed. If you ever want to tune the cool-down window or turn it off,
there's an optional circuit-breaker setting in your config, but the safe
defaults are designed to just work.

- The failure-watcher now also notices when a change gets undone — and treats
  that as "this was probably a real problem." It's careful not to be fooled by a
  faked undo message into marking the wrong thing as solved.
- Like the CI watcher, it's off until switched on and only quietly records — no
  alerts.
- This finishes the first set of automatic feeds (failed builds + undone
  changes). The next sets (a shipped feature breaking, and runtime fallbacks)
  are separate, later steps.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Account-global LLM rate-limit circuit breaker | Automatic. When the provider returns a usage/rate/spend-limit error, all background LLM-backed work pauses (no subprocess spawned) and self-heals via a single probe after the cool-down. |
| Tunable cool-down / kill switch | Optional `intelligence.circuitBreaker` in `.instar/config.json`: `enabled` (default true) and `openMs` (default 900000 = 15 min). Absent config uses the safe defaults, so existing agents are protected with no changes. |
| Revert ingestion source | Set `monitoring.failureLearning.sources.revert: true` |

## Evidence

**Reproduction (the incident pattern), reproduced as an automated test:** a fake
`claude` binary that records each spawn to an on-disk counter and exits with
"Claude AI usage limit reached" on stderr.
`tests/integration/llm-circuit-breaker-chokepoint.test.ts` builds two providers
through the real `buildIntelligenceProvider` factory and drives them:

- Before fix (old behaviour): every `evaluate()` call spawns the binary →
  unbounded spawns while limited (this is exactly the $452 burn).
- After fix (observed in the test): the first call spawns once and trips the
  breaker; the next 5 calls — and a call through a *second, independently built*
  provider — all reject with `LlmCircuitOpenError` and the spawn counter stays
  at **1**. Zero additional subprocesses, proving the burn is stopped and the
  breaker is account-global.

39 new circuit-breaker tests pass (state machine both-sides-of-boundary, the
rate-limit classifier on true-positive and unrelated-error strings, and the
chokepoint wiring). `tsc --noEmit` clean. The server log emits
`[llm-circuit] OPEN: …` / `[llm-circuit] closing: …` lines on each transition.

For the revert ingestion source:

- 13 tests green: RevertDetector (9 — parse, trusted close,
  failed-cross-check-no-close, no-original forensic record, revert² skip,
  unreachable→low-confidence, loop self-exclusion, idempotent across ticks,
  fail-open), wiring-integrity (4 — CI poller + revert detector each constructed
  iff its own flag is set).
- `tsc --noEmit` clean; existing failure-learning + slice-1a tests unaffected.
- Side-effects review: `upgrades/side-effects/failure-learning-revert-source.md`.
