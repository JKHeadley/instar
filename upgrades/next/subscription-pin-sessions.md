<!-- bump: minor -->

## What Changed

Adds subscription-pool **session pinning** — the prerequisite that makes auto-swap functional. New `subscriptionPool.pinSessionsToPool` config (default off): when enabled, a new claude-code session launches under the scheduler-picked optimal pool account's config home (`CLAUDE_CONFIG_DIR`, chosen by reset-date/headroom score) and the session record is tagged with `subscriptionAccountId`. `SessionManager` gains an injectable `spawnAccountResolver` (set by the server only when the flag is on); both initial-spawn lanes (headless + rerouted-interactive) consume it, guarded to claude-code. This fixes a structural no-op: auto-swap only moves sessions carrying `subscriptionAccountId`, but no spawn ever wrote that field, so a session that hit its account's quota wall just died instead of swapping. Gated to a strict no-op by default (resolver unset → byte-identical behavior); the account-swap restart path already tagged swapped sessions and is untouched.

## What to Tell Your User

Load-balancing across your accounts now actually works. Before, "auto-swap" was on but did nothing — your sessions ran on a default login with no record of which account they were using, so when one hit its weekly limit the work just stopped instead of moving to a fresh account. Now I can launch the agent on a specific account from your pool and tag it, so when that account walls I move the work to one with headroom. It's behind a switch that's off by default, and when you turn it on I'll point the agent at an account with room to spare.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Pin sessions to a pool account (enables auto-swap) | set `subscriptionPool.pinSessionsToPool: true` (then restart) |
| Session carries its account | `subscriptionAccountId` on GET /sessions records |

## Evidence

Reproduction (live, 2026-06-08): a session hit "You've hit your weekly limit" on the Justin (headley.justin@gmail.com) account and died — no swap. Root cause verified directly: auto-swap's handler does `if (!session.subscriptionAccountId) return;`, and a live query showed **0 of 60 running sessions carried `subscriptionAccountId`** (the field was never written — sessions spawned on the default config, not via the pool). So auto-swap was a no-op.

After the fix: the unit suite (`session-manager-behavioral.test.ts`) asserts a pinned spawn's real tmux `new-session` argv contains `CLAUDE_CONFIG_DIR=<account home>` and the session record + persisted state carry `subscriptionAccountId` — and that NEITHER appears when the resolver is unset or returns null. The integration test (`subscription-pin-sessions.test.ts`) drives the full production chain (real SubscriptionPool + the real `selectAccount` resolver wired as server.ts does) and confirms the spawn pins to the higher-headroom/sooner-reset account. tsc + repo lint clean; 73-test regression sweep green.
