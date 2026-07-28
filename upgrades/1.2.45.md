# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

PR 6 of the tunnel-failure-resilience chain. The previous releases built the machinery for a consent-gated backup tunnel: when Cloudflare can't give you a dashboard link, the agent can fall back to a third-party relay — but only after the owner explicitly approves, because that relay's operator can briefly see your dashboard traffic. Until now that approval had no actual user interface; the state machine existed but nothing asked you.

**The gap.** When Tier-1 (Cloudflare) was exhausted and a Tier-2 relay was available, the manager moved to `awaiting-consent` and waited — but the only owner-facing message was a plain-text DM with no way to act on it. There was no wired path from "owner taps a button" back to `grantConsent`/`declineConsent`.

**The fix.** The owner now gets a private DM with two inline buttons — "Yes, use a backup" / "No, keep waiting." Tapping one drives the consent state machine directly. The button click is gated to the **owner principal only** (not the broader authorized-users set — a deliberate, externally-reviewed security boundary, since approving a relay exposes private traffic), and each prompt carries a single-use random token so a stale or replayed tap can't activate anything. The plain-text consent DM is suppressed when buttons are available, so you never get a double message. The whole path also works when the agent is in send-only mode and the Lifeline is forwarding callbacks — which is exactly the situation a tunnel outage tends to create.

## What to Tell Your User

- If your dashboard link ever goes down and the agent has a backup option, it will now DM you two buttons instead of leaving you with an un-actionable message.
- Only you (the owner) can approve a backup — taps from anyone else are refused, and the prompt explains plainly that a backup briefly routes your dashboard traffic through someone else's server and that your PIN/token will be rotated afterward.
- Nothing changes for the normal case where Cloudflare is healthy — you won't see any of this unless the primary tunnel fails.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Owner consent buttons on tunnel fallback | Automatic — fires only when Tier-1 is exhausted and a Tier-2 relay is available; tap a button in the owner DM |
| Owner-principal gate on consent | Automatic — only `ownerUserId` (falls back to `promptGate.ownerId`) may approve; others are refused |

## Evidence

- Spec: `specs/dev-infrastructure/tunnel-failure-resilience.md` Part 3 (consent UX). Side-effects: `upgrades/side-effects/consent-telegram-buttons.md`.
- Tests: 10 unit tests in `tests/unit/tunnel-consent-telegram.test.ts` — 6 on the manager↔adapter seam (handler registration, prompt carries the live nonce, no double-send, grant→relay-active, decline→exhausted+cooldown, stale-nonce no-op) and 4 on the security-critical adapter callback gate (owner grant/decline, NON-owner rejected without invoking the handler, malformed `tc:` data refused).
- Wiring verified: the production call site `tunnel.attachTelegram(telegram, …)` exists in `src/commands/server.ts`, and a unit test asserts `attachTelegram` registers the consent handler — not dead code.

## Rollback

Purely additive. Revert the three method additions in `TelegramAdapter`, the `attachTelegram` handler-registration + `suppressConsentDM` wiring in `TunnelManager`, and the `suppressConsentDM` flag in `TunnelNotifier`. No config schema, migration, or persistent state to clean up; `suppressConsentDM` defaults false.
