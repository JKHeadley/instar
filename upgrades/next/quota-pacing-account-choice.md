# Account choice reads each limit window correctly (quota pacing, step 2)

<!-- bump: patch -->

## What Changed

When a session is started or moved, Instar picks a subscription account. On development agents (dev-gated, `subscriptionPool.pacing.windowAwareChoice`), both pickers now share one window-aware rule (docs/specs/quota-pacing-account-choice.md):

- The use-before-reset score pairs weekly room with the soonest weekly reset. The 5-hour reset no longer sets urgency, so an account whose week ends in two hours is no longer outranked by one with six days left.
- A session launching a Fable model is judged against the Fable window too. If no account has Fable room, it still gets an account (ranked by Fable room), never none.
- A window whose reset has passed, a placeholder reading, or a reading older than 60 minutes is "not yet checked". It is never counted as room and never as last cycle's number. Such an account is used only when no account with a real reading qualifies, and it asks the quota poller for one out-of-cycle read. The reads are deduped, backed off, held behind a breaker after 6 failures, and live-only for Codex.
- The default spawn picker (most sessions) used to take the least-used account. It now uses the same rule over its fresh accounts.
- The quota poller records how each window with an empty reset was read, the original reset it blanked, and which windows the provider listed. A Claude window the usage endpoint reports as not running is idle (measured room). Codex idle premise unverified; Codex post-reset rewrites read as rolled until a live read shows a new window.
- The quota throttle reads the same window-aware headroom: a rolled or unknown window reports no percentage, an unmeasured best account marks the reading degraded, and an open re-read breaker is reported.
- Proactive swaps treat a rolled, placeholder or old-cycle reading as invalid. Whole-pool measurement-blindness counts a rolled reading only after two failed out-of-cycle reads.
- One shadow row per executed placement goes to `logs/placement-shadow.jsonl`, trimmed to 30 days. It is readable through `GET /quota-pacing/account-choice` as a pool-wide per-day summary, or as paged raw rows per machine.

With the switch off (the fleet default), every picker runs exactly today's code.

## What to Tell Your User

- **Better use of expiring quota**: "When I start a new session, I now send it to the account whose weekly allowance is about to expire, and I never treat an account I haven't checked recently as empty. That means less of your subscription goes unused at each weekly reset. It's on for my development machines first, and I'm keeping a record of every choice so we can see the effect over the next two weeks."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Window-aware account choice | Automatic on development agents (`subscriptionPool.pacing.windowAwareChoice`) |
| Account-choice shadow evidence | `GET /quota-pacing/account-choice` (summary), `?scope=local` or `?machine=ID` (raw rows, paged) |

## Evidence

Unit, wiring, integration and e2e tests are listed in upgrades/side-effects/quota-pacing-account-choice.md. The live test-agent run in the spec's maturation plan is owed before merge.
