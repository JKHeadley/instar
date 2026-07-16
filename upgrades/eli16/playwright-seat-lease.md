# Playwright Seat Lease — Plain-English Overview

> The one-line version: one active agent drive controls the logged-in browser seat at a time, and a crashed drive gives it back automatically.

## The problem in one breath

Two sessions can currently use the same logged-in Playwright browser profile at once. Each session believes it owns the page, so one can navigate or click while the other is reading the prior page; Telegram sends then fail or land in the wrong state.

## What already exists

- **Playwright profile registry** — records which physical browser profile holds each account and can activate a selected profile.
- **External-operation hook** — already runs immediately before every MCP tool call, which makes it the reliable place to prevent conflicting browser access.

## What this adds

Every Playwright tool call first acquires or renews one host-wide lease. The lease is shared across agent project directories because the physical default browser profile is shared at the machine level. A different drive is refused while the lease is live and receives the current holder label plus a retry delay.

## The safeguards

**No unsafe profile cloning.** The design does not copy live cookies, browser databases, or lock files. Cloning would duplicate sensitive session material and still would not make one Telegram login safely concurrent.

**No permanent deadlock.** The lease expires ten minutes after the holder's last Playwright call, beyond Instar's bounded browser-tool execution window. Repeated calls by the same spawn-unique session renew it without changing ownership; a restarted session cannot impersonate its predecessor, and an abandoned drive releases automatically.

**No broad browser outage.** Only a confirmed live conflict blocks. If the local lease endpoint or state file is unavailable, the existing browser path remains available and the coordination protection degrades open. The route remains available even when the optional profile registry is disabled.

## What ships when

This ships as one bounded change: the host-wide lease primitive, one authenticated acquisition route, enforcement in the existing MCP hook, migration through the existing hook updater, and unit/integration tests.

## What you actually need to decide

The dispatched design choice is resolved as a lease, rather than profile cloning, because the contention is over one physical authenticated browser seat.
