---
review-convergence: complete
approved: true
approved-by: justin (verbal, topic 2169: "Yes, I agree. Please proceed." for the real-world-state fixture framework; AND topic 16566, 2026-05-30: directed the settled-throttle detection fix — "make sure a session can't hang forever due to these API errors ... maybe we should consider sending a message to the user in the meantime")
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**1. Pipeline post-mortem lever B: a new test category for real-world-state
scenarios.** Closes the broader pattern #1 from the 2026-05-29 post-mortem
— "Tested on fresh state, not real-world state" — which was the largest
of the five named bug classes (PRs #534, #512, #509, #501, #503, #542
all instances).

`tests/real-world-state/` joins `unit/`, `integration/`, and `e2e/` as a
peer test category. Scenarios in it exercise instar against state that
LOOKS LIKE a real production agent (externalized secrets, multi-100MB
DBs, wrong-ABI binaries, concurrent state, etc.) rather than the small
fresh-fixture state the existing suites use.

A two-tier system controls CI cost:

- **'pr' tier** runs every CI shard. Small fixtures, < 30s setup.
- **'nightly' tier** is gated on `INSTAR_REAL_WORLD_BIG=1` env. Default
  OFF. For multi-100MB DBs, wrong-ABI binary swaps, concurrency-at-scale
  scenarios. The skip is loud (`describe.skip` with a clear message) so
  the coverage gap is visible, not silently absent.

The first scenario — `externalized-config-boot` — targets the #542
incident class. It asserts that `loadConfig()` (the canonical
production read path) merges the real `authToken` string back from the
secret store when the on-disk config holds `{ "secret": true }`, plus
the same for telegram token/chatId, dashboard PIN, and tunnel token.
5 tests; verified positive AND destructive-negative (disabling the
merge call trips 4 of the 5 with the failure modes the bug produced).

This is the LAST recommended post-mortem lever. PR #542 (silent-403)
through #552 (bare-catch ban) closed individual incident classes; THIS
one closes the broader pattern that produced them.

**2. Throttled sessions can no longer hang forever on a 429 — the RateLimitSentinel
now actually fires.** The sentinel that's supposed to ride out Anthropic's
server-side capacity throttle ("Server is temporarily limiting requests · not
your usage limit") was built, wired, and enabled — but in the field it had fired
**zero** times. Sessions would sit dead for 5–10 minutes after a throttle until
the 15-minute silence fallback limped in with a generic nudge.

Root cause was the detection preconditions, not the recovery machinery. The
watchdog's throttle check demanded a session be "cleanly idle, zero active child
processes, at a prompt, throttle string within the last 20 lines." A busy dev
session almost never satisfies that: it usually has a background shell or MCP
process alive, and Claude Code's input box + footer + task list render 15–25 rows
*below* the "API Error:" line, pushing the throttle string out of the 20-line
window. So the preconditions essentially never held, and the fast recovery never
engaged.

The fix replaces those brittle gates with a **settled-output signal**: the
throttle string is matched in a **widened 45-line window** (covers the input box),
and the pane must be **byte-identical across two consecutive watchdog polls**. An
actively-working Claude session animates its spinner and elapsed-timer every tick,
so byte-identical output across polls is a rock-solid "this turn ended and the
session is stuck" signal — with no process-tree inspection (the gate that made
busy sessions invisible) and no at-prompt heuristic (the input box used to hide
the error). Once detected, the existing lifecycle takes over: immediate user
notice → escalating backoff → neutral re-engage → JSONL-growth verification →
periodic check-ins → escalation. After a recovery cycle gives up (~30s) a
still-stuck pane re-emits, so recovery retries **unboundedly until the throttle
clears** — that is the "a session can never hang forever" guarantee. Every
sentinel lifecycle transition (detected → resuming → recovered/escalated) is now
written to `logs/sentinel-events.jsonl`. Tuned by
`monitoring.watchdog.rateLimitSettleMs` (default 20000ms).

## What to Tell Your User

First, nothing visible in normal operation from the test-framework change. There's
an opt-in heavier set of local tests for big real-world fixtures; CI runs the fast
set by default, so day to day nothing changes for you.

Second, mostly invisible and strictly an improvement: if one of your sessions hits
Anthropic's temporary server throttle (a "Server is temporarily limiting requests"
error — their side, not your usage limit), it will now recover on its own instead
of silently sitting dead. You'll get a brief heads-up — "hit a temporary throttle,
I'm backing off, you haven't been dropped" — plus check-ins while it waits and a
"back online" when it clears. It keeps retrying until the throttle lifts, however
long that takes. Nothing for you to do, no configuration needed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `tests/real-world-state/` test category | Add a new scenario file there. Use `describeAtTier('pr', …)` or `describeAtTier('nightly', …)`. |
| Tier-gated execution | 'pr' runs every shard; 'nightly' skips unless `INSTAR_REAL_WORLD_BIG=1`. |
| `makeAgentFixture()` helper | Per-test scratch dir simulating an agent home (projectDir + .instar/). Returns a cleanup callback. |
| Externalized-config-boot regression check | `loadConfig()` against the externalized shape is asserted on every PR. #542's class can never regress silently. |
| Settled-throttle detection | Automatic — the SessionWatchdog recovers a 429-stuck session via a byte-identical-pane signal over a widened scan window, so busy dev sessions are no longer invisible to the RateLimitSentinel. |
| Unbounded throttle retry | Automatic — recovery re-engages after each escalation cycle, guaranteeing a throttled session cannot hang forever. |
| `monitoring.watchdog.rateLimitSettleMs` | Optional tuning for how long a throttled pane must be settled before recovery engages (default 20s). |

## Evidence

**Real-world-state fixture framework (#555):**
- 5 new tests in `tests/real-world-state/externalized-config-boot.test.ts`,
  all green. Tier system verified both directions (sentinel test).
- Destructive-negative verified: disabling `mergeConfigWithSecrets()` in
  `Config.ts` trips 4 of the 5 tests with the exact failure modes
  (`{ secret: true }` returned as authToken, telegram token leaks, etc.).
- Existing `secret-migrator.test.ts`, `config-secret-merge.test.ts`,
  `secret-store.test.ts` remain green. `tsc --noEmit` clean.
- Side-effects: `upgrades/side-effects/real-world-state-fixture-framework.md`.

**Settled-throttle detection:**
- **Reproduction (unit):** `tests/unit/rate-limit-detection.test.ts` builds the
  exact stuck-pane shape — the `API Error:` line followed by Claude's input box +
  footer + ~14 trailing blank rows. `detectRateLimited(paneWithInputBox())` is
  **false** with the default 20-line window (the bug) and **true** at 45.
- **Observed before (production, this box, 2026-05-30):** zero RateLimitSentinel
  fires across every server instance overnight (no `rateLimitedAtIdle`, no
  `[RateLimitSentinel] detected`, no `[Watchdog] rate-limited` in `logs/server*.log`)
  while three live sessions sat frozen on `Churned for 7m 43s` / `Sautéed for
  9m 28s` / `Baked for 5m 58s`; only the 15-min `ActiveWorkSilenceSentinel` engaged.
- **After:** settled detection emits → existing backoff/verify lifecycle runs +
  writes `throttle-detected`/`throttle-resuming`/`throttle-recovered`. Live
  end-to-end verification on the deploy box before closing the incident.
- Side-effects: `upgrades/side-effects/throttle-settled-detection.md`. Spec:
  `docs/specs/rate-limit-sentinel.md`.
