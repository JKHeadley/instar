# Side-Effects Review — usage-wall rescue on the current Claude Code layout

**Version / slug:** `usage-wall-current-layout`
**Date:** `2026-11-10`
**Author:** `Echo`
**Tier:** 1 (narrow bug fix; a revert fully undoes it). About 10 source/test files, roughly 600 added lines, most of them tests. One review pass, first commit attempt.
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Operator report fb-f8b946ae-597 (2026-11-10): session echo-instar-app sat at "You've hit your weekly limit" for 20+ minutes while seven accounts had room. Two independent faults.

1. **Reactive rescue never triggered.** `detectUsageWall` requires every row after the banner to be known Claude Code chrome. The current layout puts six unknown rows there (the new "/usage-credits to finish" wording, a usage-credits promo row, the "✻ Baked for 3s · done 7:56 AM · 7 shells still running" finished-turn row, "✔ Update installed · Restart to update", "⏵⏵ bypass permissions on · 7 shells · ↓ to manage", background-agent rows with live timers) plus a right-hand diff panel that writes text on every row. The detector returned false on the real pane, and the ticking timers meant the whole-pane settle fingerprint never stayed equal.
2. **Proactive swap never escalated.** The swap ledger shows the session deferred `busy-turn`, dropped at the 30-minute ceiling, sat out the 45-minute re-intent backoff, and deferred again at age 0: nine deferrals and eight drops between 06:06Z and 16:06Z. Background shells keep the turn leg "working", so it could never finish.

Fix:

- `rateLimitDetection.ts`: `stripSidePanel` cuts rows at a vertical rule found on the same column in ≥5 rows and ≥40% of non-blank rows. Anchored chrome patterns for each new row. "⏺ main" counts as chrome only above a background-agent row. `/usage-credits to finish` is a banner row. The settle fingerprint (`usageWallSignature`) covers the banner and the 15 rows above it, never the chrome below. `paneShowsUsageWallBanner` is the weaker pane corroboration: a banner with no retry spinner and no model output (a "⏺" reply or tool-call row) after it.
- `sessionUsageLimitEvidence.ts` + `SessionManager.usageWallFromTranscript`: the exact session's transcript proves the wall when its latest main-turn row is the provider's `rate_limit` API error **and** the text is the wall banner. The throttle uses the same error code, so the text test is required.
- `SessionWatchdog.checkUsageWall`: the wall is current if the pane alone shows it, OR the pane shows a banner (no retry spinner after it) and the transcript confirms it. The transcript is read only when a banner is on screen and the pane-only check failed.
- `ProactiveSwapMonitor`: a per-session busy episode survives the ceiling drop. When the episode has been deferred a full ceiling and the source account is at or above `swapContinuity.wallEscalationPct` (default 95), the intent executes through the `reactive-swap` class (the bounded grace, then the swap with the mitigation payload) instead of being dropped. Once per episode. The ledger row carries `wallEscalated: true`.

## Decision-point inventory

- Watchdog `usage-wall` emission: emits in more cases (new layout, transcript-confirmed).
- `ProactiveSwapMonitor` busy branch: one new outcome (escalate) between "keep deferring" and "drop".
- No new blocking authority. The escalation reuses the reactive-swap kill path that already runs at the wall.

## 1. Over-block

Nothing is blocked by this change. The opposite risk is over-firing:

- **Wall reported while the session is working.** Every new chrome pattern is anchored to a whole row with a closed set of segments. Look-alike prose is tested on both sides (e.g. "✻ Baked for 3s and then I rewrote the parser", "✔ Update installed for the API client in src/api", "Usage credits are cheaper this month", a bare "⏺ main"). The transcript path also needs the session's own latest main-turn row to be the provider's wall error, which a working session overwrites on its next turn. UsageWallRescue still corroborates every wall against the account's quota reading before it moves anything.
- **Escalation kills a turn that would have landed.** This only happens after the session has read busy at every probe for a full ceiling (summed across ceiling drops; any idle probe ends the episode) and with the account ≥95% measured. At that level the next turn walls anyway, which is the same reasoning the reactive class uses. The reactive grace (default 2 min) still lets work that is about to land finish cleanly, and the mitigation payload lists interrupted subagents and re-injects the unanswered message.

## 2. Under-block

- A future layout row the chrome list does not know still defeats the pane-only path. The transcript path covers that whenever the session id is known. Sessions whose id is unknown and whose pid file is missing fall back to pane-only.
- The side panel is found by column agreement. A panel narrower than 5 rows, or a pane where the rule column moves a lot between rows, is not stripped.
- Busy episodes are in memory. A server restart starts a new episode, so after a restart escalation can come up to one ceiling (30 min) later than it would otherwise. The reactive floor (fault 1 fixed) covers that window.
- Escalation applies only to the `quota-pressure` trigger. Login-loss and degradation intents keep the drop.

## 3. Level-of-abstraction fit

Detection stays in the pure detector module and the watchdog that already owns the `usage-wall` signal. The transcript read goes through the same SessionManager seam (`configHomeForSession`, pid-file id recovery, `resolveFrameworkTranscriptPath`) that `confirmSessionUsageLimit` already uses; the lookup is now one shared private helper. Escalation lives in the monitor, which the swap-continuity spec names as the owner of the proactive deferral lifecycle. The work gate stays a stateless predicate.

## 4. Signal vs authority compliance

The watchdog stays signal-only: it emits, and UsageWallRescue decides, corroborates against quota, and acts through the existing funnel and brakes. The escalation is a decision inside an existing authority (the proactive monitor). It runs only after the full anti-thrash brake pipeline has returned `execute` (all-hot, dwell, material target, thrash breaker, reversal), and the scheduler still revalidates the target and source at the kill point. It adds no new kill path: `callerClass: 'reactive-swap'` is the class the wall rescue already uses.

## 4b. Judgment-point check

The escalation weighs "protect in-flight work" against "do not let the session hit the wall". The rule is fixed and bounded (a full ceiling of busy-at-every-probe time + ≥95% measured + once per episode). It is a knob, not a judgment call, and it matches the reactive class's existing rule for the same trade-off one step later.

## 5. Interactions

- `currentUsageLimitBanner` (PresenceProxy notices, StuckSignatureClassifier, the server's still-walled check) now strips the side panel and knows the new rows too, so the standby wording sees the same wall the watchdog sees. Its consumers still corroborate with the transcript.
- `confirmSessionUsageLimit` keeps its exact semantics (any rate-limit API error); the new `sessionUsageWallFromTranscript` is stricter (wall text only).
- Throttle detection (`detectRateLimited`, `evaluateThrottleSettle`) is unchanged.
- Escalated swaps: the scheduler runs proactive revalidation because a target is set. SessionRefresh runs the reactive grace because of the caller class. An escalation that fails goes through the existing `recordExecFailure` backoff, and the next ceiling hit drops as before.
- `busyEpisodes` is cleared on a successful swap, on any affirmatively idle probe, on an account change, when the session leaves the running list, and when the source's measured pressure falls below the proactive threshold. The one escalation is counted when the swap is actually attempted, so a self-action admission hold does not use it up.

## 6. External surfaces

- One new optional config knob: `subscriptionPool.swapContinuity.wallEscalationPct` (default 95; above 100 disables). No migration needed, since an absent value uses the default.
- One new optional ledger field: `wallEscalated: true` on `proactive/swapped` rows.
- Log lines: `[ProactiveSwap] <session>: busy for N min on <acct> at P% … escalating`.
- Agents on the fleet: swapContinuity is dev-gated (live on development agents, dark on the fleet), so the escalation runs only where the work gate is live. The detection fix applies everywhere the wall rescue is on (default on).

## 7. Multi-machine posture

Machine-local by design. Each machine's watchdog watches its own tmux sessions and reads its own transcripts. Each machine's proactive monitor moves only its own sessions. Busy episodes describe a local session and never need to replicate. The swap ledger is per machine, as before.

## 8. Rollback cost

Revert the PR. No state migration: the new ledger field is optional and ignored by older readers, and the config knob is optional. To disable only the escalation without a release, set `wallEscalationPct: 101`.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the escalation lives inside the registered proactive-swap-monitor controller and runs only after the anti-thrash pipeline returns execute; each busy episode escalates at most once (counted at swap attempt), a failed escalation falls to the exec-failure backoff and then the ceiling drop + re-intent backoff, and a swapped session dwells, so sustained pressure settles at one escalated swap per session per episode }`.

## Second-pass review

Independent reviewer subagent, 2026-11-10. Concurred on the chrome patterns, side-panel removal, escalation flow (brakes run first, `continue` placement, dryRun untouched, scheduler revalidation, reactive grace in SessionRefresh) and the preserved `confirmSessionUsageLimit`. Raised two concerns, both fixed before commit:

1. The transcript path checked nothing below the banner, so a resumed session whose stored transcript id is still the old walled one could read as walled under a replayed banner. Fixed: `paneShowsUsageWallBanner` now refuses when a model-output row ("⏺ …", other than the task-list header) follows the banner. Test: "model output below the banner vetoes the transcript path".
2. The busy episode survived idle time, so "a full ceiling of continuous busy" was not true. Fixed: an affirmatively idle probe ends the episode, and a recreated episode starts at the current tick rather than an older deferral's start. The escalation is now counted when the swap is attempted (an admission hold no longer uses it up). Test: "an idle probe ends the busy episode".

Minor notes accepted as-is: an escalation's 2-minute reactive grace holds the monitor's tick (ticks never overlap, and this happens at most once per episode); a pane with an unclearable banner re-reads up to 128 KB of transcript per poll for that session only.

Reviewer verdict after fixes: "Concur after fixes" (60/60 in the two changed suites). Its one remaining suggestion, also treating the "●" output marker that some terminals (Linux included) draw as model output, is applied.

## Follow-up commit

The shared limit-evidence lookup moved from a private SessionManager method to a module function over `listRunningSessions`, `configHomeForSession`, `setClaudeSessionId` and the project dir. The existing integration test calls `confirmSessionUsageLimit` on a narrow stand-in, and the private method broke it. No behavior change. `tests/integration/session-usage-limit-evidence.test.ts` now also covers `usageWallFromTranscript` (wall vs throttle, exact session only); 11/11 pass.
