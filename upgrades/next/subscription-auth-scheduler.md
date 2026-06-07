# Quota-aware auto-swap scheduler + session-continuity guarantee (P1.3)

<!-- bump: minor -->

## What Changed

Added `QuotaAwareScheduler` — the third piece of the Subscription & Auth
Standard, on top of the P1.1 account registry and P1.2 quota poller. It selects
the optimal account for a session (reset-date-optimal "use before reset"
draining) and enforces a continuity guarantee: a long-lived session that hits
its account's quota resumes on another eligible account and keeps going, rather
than dying on the limit.

The swap reuses the existing session-restart machinery. A session is launched
pointed at a specific account's config home (`CLAUDE_CONFIG_DIR`); because
resuming a conversation is agnostic to which account's config home it runs under,
the same conversation picks up on a fresh account with nothing lost. The
account-swap parameters were threaded additively through the whole restart path
(SessionRefresh → respawn → spawn → launch builder), so every existing restart,
recovery, and spawn is byte-for-byte unchanged when no swap is requested.

Automatic swapping on rate-limit detection ships dark behind
`subscriptionPool.autoSwapOnRateLimit` (default off) — auto-swapping a live
session is real authority, so it is opt-in. A manual swap route
(`POST /subscription-pool/swap`) and the selection logic are always available.
When a session hits a wall and there is no eligible alternate, the scheduler
reports that honestly and raises one alert instead of pretending it swapped.

Coverage: scheduler unit tests (selection ordering, the swap-and-resume
guarantee, no-alternate, refresh-failure) + an end-to-end test that drives a
session to a mocked quota limit and asserts it resumes on the alternate account's
config home; existing session-restart tests stay green.

## What to Tell Your User

When one of your subscription accounts runs low, I can move the work to another
of your accounts and keep the same conversation going — so a long session never
just dies when an account hits its limit. I pick accounts so each one gets used
up before its quota resets, instead of wasting it. This is switched off for
automatic use until you turn it on (moving a live session is a big enough action
that I want your say-so), but I can do it on request any time. Nothing changes
for how your sessions restart today.

## Summary of New Capabilities

- **Quota-aware account selection** — picks the account with the most room that
  resets soonest, draining each before its quota resets.
- **Session-continuity guarantee** — a session at a quota limit resumes on another
  account (conversation preserved) instead of dying; if no account is available,
  it says so and leaves the existing back-off in place.
- **Manual swap** — `POST /subscription-pool/swap` resumes a named session on
  another eligible account on demand.
- **Opt-in auto-swap** — automatic swapping on rate-limit detection is available
  behind a config flag, off by default.
