# Upgrade Guide — rate-limit recovery now reaches non-topic-bound sessions

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: the rate-limit sentinel now actually recovers a session that isn't bound
to a Telegram topic.**

When Anthropic's server-side throttle hit ("Server is temporarily limiting
requests · not your usage limit"), the RateLimitSentinel detected it and ran its
backoff correctly — but both of its recovery actions started by asking "is this
session bound to a Telegram topic?" and silently did nothing if the answer was
no. A developer's interactive Claude Code window isn't bound to a topic, so:

- the "throttled, backing off, you're not dropped" notice went nowhere, and
- the resume nudge that wakes the session back up went nowhere.

From the outside this was indistinguishable from the sentinel not existing — the
exact thing observed: a throttle sat on screen for minutes with no recovery and
no signal. (v1.2.33 shipped past green tests because every test fixture was
topic-bound; the non-topic-bound path was never exercised.)

This release makes recovery reachable under **all** session conditions:

- **Resume** — topic-bound sessions get the topic-tagged nudge as before;
  non-topic-bound sessions get a trusted in-process injection
  (`SessionManager.injectInternalMessage`) that bypasses the topic-prefix
  requirement. This path is in-process only — never exposed over HTTP.
- **Notify** — the user notice goes to the session's own topic, else falls back
  to the always-available lifeline (system) topic, else is written as a loud
  `recovery-unreachable` audit event. Never a silent drop.
- **Audit** — every recovery attempt records `recovery-reached` /
  `recovery-unreachable` to `logs/sentinel-events.jsonl`, and unreachable events
  also land in `.instar/sentinel-alerts.json` so the dashboard surfaces them even
  when Telegram can't be reached.

The reachability branching was lifted out of the inline server closures into
`sentinelWiring.buildRateLimitRecoveryDeps()` so it is unit-testable — closing
the gap (inline + untestable logic) that let this ship past green tests.

Spec: `Sentinel Reachability + Worktree Isolation` (the worktree-clone and
socket/silence-default parts already shipped via #334/#340/#351; this is the
remaining rate-limit recovery piece).
Side-effects review: `upgrades/side-effects/rate-limit-recovery-reachability.md`.

## What to Tell Your User

If I'm ever hit by one of Anthropic's brief "servers are busy" throttles while
you're talking to me in a plain window (not a Telegram topic), I'll now actually
tell you I'm throttled and backing off — and I'll wake myself back up and let you
know when it clears, instead of going silent until you poke me. Nothing changes
for the normal Telegram case; this just closes the gap where a throttle in a
direct dev window left you staring at a frozen screen.

## Summary of New Capabilities

No new user-facing capabilities — this is a behavior fix to existing rate-limit
recovery. (Internal: `SessionManager.injectInternalMessage` for trusted
in-process recovery nudges; `buildRateLimitRecoveryDeps` reachability factory.)

## Evidence

**Live reproduction (the bar that was missed last time).** Drove the *real*
RateLimitSentinel lifecycle through the *real* recovery factory (wired exactly as
`server.ts` wires it) against a *real* tmux pane that was **not** bound to any
topic — the exact failure condition. Result: the resume nudge landed in the pane
via the real internal-injection path, the "throttled, backing off" notice and the
"back online" check-in both reached the lifeline topic, and the audit log
recorded `recovery-reached` with zero `recovery-unreachable`. Before the fix all
of those were silent.

**Regression coverage (CI-permanent):**
- `tests/unit/rate-limit-recovery-reachability.test.ts` (9) — both sides of every
  reachability boundary: topic / lifeline / internal-injection / unreachable.
- `tests/integration/rate-limit-recovery-sentinel-lifecycle.test.ts` (2) — the
  real sentinel lifecycle (detect→backoff→resume→verify→recovered) driving the
  factory to the lifeline for a non-topic-bound session, plus the
  never-silent unreachable case.
- `tests/unit/rate-limit-recovery-wiring.test.ts` (6) — wiring integrity (server
  wires the real primitives, not no-ops) + the InputGuard HTTP boundary.

`tsc` clean. The pre-existing rate-limit unit/integration/e2e suites stay green.
