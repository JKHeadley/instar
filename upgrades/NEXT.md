# Upgrade Guide — v1.2.18 (Telegram login UX — narrative-driven prompt)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: the Codex agentic Telegram path now narrates to the user
the way the Claude wizard does.**

v1.2.17 made Codex+Playwright the primary Telegram setup path,
and it worked technically — Playwright opened Telegram Web, Codex
started polling for login. But the user saw a QR code with no
on-screen guidance about scanning it. After 120 seconds of
silence Codex timed out and the wizard fell to the manual readline
backstop.

Root cause: my v1.2.17 prompt told Codex to "take snapshots" but
never told it to tell the user what was happening. The Claude
wizard skill has the equivalent narration ("I see the Telegram
login screen — please scan the QR code with your phone's Telegram
app, Settings → Devices → Link Desktop Device"). My Codex prompt
didn't.

v1.2.18 rewrites the prompt with:

- A new "CRITICAL CONVERSATIONAL RULES" preamble explicitly framing
  the user as someone sitting at the terminal RIGHT NOW, only
  seeing prose Codex prints (not snapshots, not tool calls, not
  internal reasoning).
- Step-2 specifies the exact instruction block to print after the
  browser opens — what's on screen, how to open Telegram on the
  user's phone (with an "install from app store if you don't have
  it yet" note), the menu path (Settings → Devices → Link Desktop
  Device), and how long the wizard will wait.
- Step-3 polls for the login transition for up to **5 MINUTES**
  (was 120 seconds) with periodic 25-30s user-facing reminders
  about what they need to do.
- Brief narrations between BotFather sub-steps ("Bot's ready.
  Creating a group chat now and adding the bot.", "Telegram is
  connected.").

The verifier (`verifyTelegramConfig`) still authoritatively
decides whether the agentic path succeeded. No new authority, no
new abstraction, no new scaffolding from instar — just better
prompt content that makes Codex behave like the Claude wizard
does.

Spec: `specs/dev-infrastructure/telegram-login-ux.md`.
ELI16: `specs/dev-infrastructure/telegram-login-ux.eli16.md`.
Side-effects: `upgrades/side-effects/fix-telegram-login-ux.md`.

## What to Tell Your User

The Telegram setup step now tells you exactly what to do when the
browser opens — open Telegram on your phone, go to Settings →
Devices → Link Desktop Device, scan the QR code in the browser
window. If you don't have Telegram on your phone yet, it'll tell
you to grab it from the app store first. You have 5 minutes to
complete the scan; the wizard reminds you periodically while it
waits.

## Summary of New Capabilities

No new capabilities. Prompt-content UX fix on top of v1.2.17.

## Evidence

Reproduction prior: ran v1.2.17 install on instar-codey. Codex
opened Telegram Web, printed "Telegram Web is still on the QR
login screen. I'm continuing 5-second snapshot polling..." three
times across 120 seconds with no user-actionable text, then
AGENTIC_FAILED: telegram-login-timeout. User had to switch to
manual.

After fix:
- 2 new unit tests cover the v1.2.18 prompt additions (the
  conversational-rules section and the 5-minute window).
- 18 existing prompt/verifier/MCP tests still pass.
- Manual end-to-end re-test on Codex install path pending on
  publish.
