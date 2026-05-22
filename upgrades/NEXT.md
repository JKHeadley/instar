# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = owner-DM channel + notifier sink wiring; no public API breakage -->

## What Changed

**feat(tunnel,telegram): owner-DM channel + two-channel notifier wired into the tunnel manager.**

PR 3 of the tunnel-failure-resilience chain. Lands the owner-DM
messaging surface that the upcoming consent UX + relay providers
(PR 4) and credential rotation lifecycle (PR 5) depend on. Spec
`specs/dev-infrastructure/tunnel-failure-resilience.md` is converged
and approved on main.

What's new:

- `TelegramAdapter.ownerUserId` config field — the single Telegram
  user id who controls security-sensitive decisions for this
  instance (consent gate for backup tunnels, credential exposure).
  Separate from the broader `authorizedUserIds` allowlist per the
  GPT external review's CRITICAL finding that consent decisions
  must not trust the broader set. Falls back to
  `promptGate.ownerId` for back-compat when not set explicitly.
- `TelegramAdapter.getOwnerUserId()` — returns the configured owner
  principal (or the back-compat fallback).
- `TelegramAdapter.sendToOwnerDM(text)` — sends a private DM to the
  owner's direct bot chat. Failure modes ("no owner configured",
  "owner hasn't messaged the bot yet", network error) log a warning
  and return null; never throw into the caller. Telegram bots can
  only initiate a DM after the user has messaged the bot at least
  once, so an early forbidden response is expected and non-fatal.
- `TunnelManager.attachTelegram(adapter, dashboardPin)` — wires the
  notifier sink. Group messages route to the Dashboard topic (with
  Lifeline fallback); owner-DM messages route to
  `sendToOwnerDM`. A credentialProvider callback returns the live
  URL + current PIN at compose time, so the notifier never holds
  stale credentials in its own state. `server.ts` calls
  `attachTelegram` after the Dashboard topic is ensured.
- `TunnelNotifier` composers — the four owner-DM messages
  (recovered, restored, consent prompt, relay activated) now render
  real English text with credentials substituted. Group-channel
  messages continue to carry status text only — credentials NEVER
  appear in group messages.

What's NOT new yet (deliberate, future PRs in this chain):

- Inline-button consent UX + callback handler (PR 4).
- Tier-2 relay providers (localtunnel) + the actual consent-driven
  transition into `relay-active` (PR 4).
- `authToken` / PIN rotation on relay-episode end + boot recovery
  (PR 5).
- Full N-consecutive-success self-heal stability gate (PR 6).
- The auth-gated `/tunnel` route (PR 7).

The lifecycle state machine already supports all of these; the
manager just doesn't transition into the relevant states yet.

## Evidence

3 new unit tests in `tests/unit/tunnel-manager-rewrite.test.ts`:

- `attachTelegram` routes the "couldn't reach" group message to the
  Dashboard topic id.
- `attachTelegram` falls back to the Lifeline topic when no Dashboard
  topic is configured.
- `attachTelegram` owner-DM message carries the live URL and current
  PIN (credential substitution at compose time).

1 new + updated tests in `tests/unit/tunnel-notifier.test.ts`:

- The credential-snapshot test now uses a real credentialProvider and
  asserts the URL + PIN appear in owner-DM messages AND that they
  NEVER appear in group messages.
- New "renders a graceful 'link not available' placeholder when no
  credentialProvider is wired" test for the test-injection /
  partial-wire-up path.

All 71 tunnel-related unit tests pass (32 lifecycle + 10 providers +
13 notifier + 19 manager). Typescript and lint clean.

## What to Tell Your User

This release adds the plumbing for owner-only private messages from
the agent to you, separate from the group topics where everyone
sees the same messages. Nothing visible to you yet — the upcoming
release uses this plumbing to message you directly when Cloudflare
goes down and asks whether to use a backup. The release after that
uses the same channel to send you new dashboard credentials after a
backup tunnel finishes its work and your auth token rotates.

If you want to set the owner explicitly, the relevant config field
is your Telegram user id. The agent falls back to your prompt-gate
owner id if it's already set, so most existing installs don't need
to change anything.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Owner-DM channel | Automatic — the agent picks up your owner id from existing config and uses it for security-sensitive messages |
| Live credential substitution in DMs | Automatic — when the tunnel sends you a link, the URL + PIN are always the current ones |
| Group-vs-DM channel separation | Structural — credentials never appear in group messages regardless of how the tunnel layer wires up |
