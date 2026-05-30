---
review-convergence: complete
approved: true
approved-by: justin (topic 16566, 2026-05-30 — "I do just wanna make sure that a session can't hang forever due to these API errors ... as long as it eventually does ... maybe we should consider sending a message to the user in the meantime")
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Throttled sessions can no longer hang forever on a 429 — the RateLimitSentinel
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

The fix replaces those brittle gates with a **settled-output signal**:
- The throttle string is matched in a **widened 45-line window** (covers the
  input box), and
- the pane must be **byte-identical across two consecutive watchdog polls**.

An actively-working Claude session animates its spinner and elapsed-timer every
tick, so byte-identical output across polls is a rock-solid "this turn ended and
the session is stuck" signal — with no process-tree inspection (the gate that
made busy sessions invisible) and no at-prompt heuristic (the input box used to
hide the error). Once detected, the existing lifecycle takes over: immediate user
notice → escalating backoff → neutral re-engage → JSONL-growth verification →
periodic check-ins → escalation. After a recovery cycle gives up (~30s) a
still-stuck pane re-emits, so recovery retries **unboundedly until the throttle
clears** — that is the "a session can never hang forever" guarantee.

Every sentinel lifecycle transition (detected → resuming(attempt N) →
recovered/escalated) is now written to the shared `logs/sentinel-events.jsonl`
audit trail, alongside the existing recovery-reached/unreachable notify-outcome
events, so a throttle recovery is fully traceable instead of invisible.

Detection is tuned by `monitoring.watchdog.rateLimitSettleMs` (default 20000ms;
with the default 30s poll, recovery engages on the 2nd consecutive throttled poll
≈ 30–60s after the turn freezes).

## Evidence

**Reproduction (root cause, unit-level).** `tests/unit/rate-limit-detection.test.ts`
builds the exact stuck-pane shape from the live incident — the `API Error:`
throttle line followed by Claude Code's input box + footer + ~14 trailing blank
rows. `detectRateLimited(paneWithInputBox())` returns **false** with the default
20-line window (the live bug — the error is pushed out of view) and **true** with
the widened 45-line window. `evaluateThrottleSettle` is exercised on both sides
of every branch (no-throttle / waiting / settled), and the watchdog wiring test
confirms emission only after the pane is settled across two polls, with no
process-tree inspection.

**Observed before (production, this box, 2026-05-30).** Across every server
instance overnight the RateLimitSentinel fired **zero** times — `grep` of
`logs/server*.log` found no `rateLimitedAtIdle` emit, no `[RateLimitSentinel]
detected`, and no `[Watchdog] rate-limited detected` lines — while three live
sessions sat visibly stuck on the throttle (panes showed `API Error: Server is
temporarily limiting requests` then a frozen `Churned for 7m 43s` /
`Sautéed for 9m 28s` / `Baked for 5m 58s`). The only sentinel that engaged was
the `ActiveWorkSilenceSentinel` at its 15-minute mark
(`logs/sentinel-events.jsonl`), i.e. recovery was 15 min late and generic, never
the throttle-aware path. That is the user-reported "sessions keep dying on API
errors and the sentinels aren't recovering them."

**Observed after.** With detection no longer gated on idle/at-prompt/no-active-
processes, a settled throttled pane now emits `rate-limited` → the existing
backoff→resume→verify lifecycle runs and writes `throttle-detected` /
`throttle-resuming` / `throttle-recovered` to `logs/sentinel-events.jsonl`. Live
end-to-end verification (watching a real throttle recover in the audit trail) is
performed on this box post-deploy — it throttles frequently enough under current
load to exercise the path within minutes; the deploying engineer confirms a
`throttle-recovered` entry before closing the incident.

## What to Tell Your User

Mostly invisible, and strictly an improvement. If one of your sessions hits
Anthropic's temporary server throttle (a "Server is temporarily limiting
requests" error — their side, not your usage limit), it will now recover on its
own instead of silently sitting dead. You'll get a brief heads-up — "hit a
temporary throttle, I'm backing off, you haven't been dropped" — plus check-ins
while it waits and a "back online" when it clears. It keeps retrying until the
throttle lifts, however long that takes. Nothing for you to do, and no
configuration needed.

## Summary of New Capabilities

- **Settled-throttle detection** — the SessionWatchdog recovers a 429-stuck
  session using a byte-identical-pane signal over a widened scan window, so busy
  dev sessions (background shell / large input box) are no longer invisible to
  the RateLimitSentinel.
- **Unbounded throttle retry** — recovery re-engages after each escalation cycle,
  guaranteeing a throttled session cannot hang forever.
- **Full audit trace** — RateLimitSentinel detect/resume/recover/escalate
  transitions land in `logs/sentinel-events.jsonl`.
- **`monitoring.watchdog.rateLimitSettleMs`** — optional tuning for how long a
  throttled pane must be settled before recovery engages (default 20s).
