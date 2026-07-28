# Side-effects review — Proactive pre-limit account swap

## Blast radius when DISABLED (default)

Strict no-op. `subscriptionPool.proactiveSwap.enabled` defaults to absent/false →
the `ProactiveSwapMonitor` is never constructed, never started, never wired into
the AgentServer ctx. The two new routes answer `200 { enabled:false }` (never
503). No new background loop, no polling, no session restarts. An agent that
doesn't set the flag behaves byte-for-byte as before.

## Blast radius when ENABLED

- **It restarts live sessions.** A proactive swap drives the same
  `SessionRefresh` account-swap path the reactive `autoSwapOnRateLimit` already
  uses (kill → respawn with `--resume`, conversation preserved via the topic's
  resume UUID). Same authority and same disruption profile as the already-shipped
  reactive swap — only the trigger is earlier (a measured threshold vs. an actual
  rate-limit escalation). This is why it is opt-in.
- **It can move UNTAGGED sessions.** An untagged session's effective account is
  resolved from the default-config login via `InUseAccountResolver` (cached
  `claude auth status`). A wrong/blank resolution degrades to "no default
  account" → that session is simply not a candidate (fail-safe, never a wrong
  swap). After a swap the session becomes tagged with its new account.

## Bounding / anti-footgun

- `maxSwapsPerCycle` (default 3) caps restarts per pass; per-session `cooldownMs`
  (default 10m) prevents double-swapping a session whose restart is still
  settling; an alternate-must-be-below-threshold guard prevents moving onto a
  nearly-full login (anti-thrash). Near the wall the monitor refreshes the poll
  before deciding so a fast burn isn't missed.
- Complements (never conflicts with) the reactive swap: once proactive moves a
  session off a hot login, the reactive escalation for that login can't fire for
  it. Both can be enabled together.

## Interactions

- Reads `state.listSessions({status:'running'})`, `subscriptionPool.list()`,
  `inUseAccountResolver.resolve()`, and calls `quotaPoller.pollAll()` +
  `quotaAwareScheduler.onQuotaPressure()` — all existing surfaces, no schema
  changes. Adds `subscriptionAccountId`-keyed logic but writes no new state.
- CapabilityIndex gains two endpoints + a `proactiveSwap` flag; the subscription
  capability description is extended. No prefix added (rides `/subscription-pool`).

## Migration parity

New `subscriptionPool.proactiveSwap` config is purely additive (absence = off →
no `migrateConfig` needed). CLAUDE.md awareness ships in the template AND via a
dedicated idempotent `migrateClaudeMd` patch for existing agents (the
section-install guard skips agents that already have the section).

## Framework generality

Does not touch the framework launch/inject abstraction. The pool is
Claude-subscription-specific by nature (claude-code accounts); the monitor only
considers `framework === 'claude-code'` (or legacy undefined) sessions, so
codex-cli / gemini-cli / pi-cli sessions are correctly ignored.

## Tests

Unit (16) — both sides of every boundary incl. the untagged→default-login
resolution; integration (6) — full HTTP for both routes incl. dark 200s; e2e (2)
— feature-alive in dark + live. Sibling subscription/quota suites + all 358
PostUpdateMigrator tests stay green.
