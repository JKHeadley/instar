<!-- bump: patch -->

## What Changed

The interactive (user-facing) session lane now pins to a subscription-pool account,
mirroring the headless lane. When `subscriptionPool.pinSessionsToPool` is enabled,
`SessionManager.spawnInteractiveSession` consults the same spawn-account resolver
that `spawnSession` uses (unless the caller passed an explicit `configHome`, e.g. the
account-swap path, which still wins). The session launches under the scheduler-picked
pool account's config home and is tagged with `subscriptionAccountId` — making the
user's own conversation directly eligible for proactive and reactive auto-swap,
instead of riding the default login untagged (rescuable only by the
ProactiveSwapMonitor's default-login fallback). The resolver-pinned home is seeded
onboarding-ready first, so a headless-enrolled home can't wedge the launch on the
first-launch wizard. Claude-code only; complete no-op when pinning is off.

## What to Tell Your User

The conversation you actually chat with is now protected the same first-class way
your background sessions are. When you pool several logins, your own chat session is
tagged to whichever login it is running on, so the moment that login gets close to
full I can move your conversation to a fresh login before it ever stalls — not just
rescue it after the fact. Nothing changes unless you have pooling turned on.

## Summary of New Capabilities

- The interactive session lane pins to a pool account and carries its account tag,
  so the user's conversation is first-class for both proactive and reactive swap.

## Evidence

- `tests/unit/interactive-session-pin.test.ts` — 6 cases: resolver-pin, explicit
  home wins, unwired no-op, empty-pool no-op, codex-not-pinned, onboarding-safe seeding.
- `tests/integration/subscription-pin-sessions.test.ts` — interactive lane pins via
  the real `selectAccount`-wired resolver; empty-pool no-op.
- `tests/e2e/session-management-e2e.test.ts` — real tmux: an interactive session is
  tagged with the resolver-picked account and its home is seeded onboarding-ready.
