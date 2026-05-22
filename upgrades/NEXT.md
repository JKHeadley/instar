# Upgrade Guide — v1.2.17 (Codex+Playwright Telegram primary path)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: the wizard's Telegram setup now uses Codex+Playwright as
the primary path, with the v1.2.15 readline flow as a verified
backstop.**

Background: v1.2.15 made Telegram setup an instar-native readline
flow because the prior Codex-driven attempt was broken — Codex
couldn't see Playwright. Investigation: instar was only
registering Playwright for Claude (in `~/.claude.json` and
`.mcp.json`), never for Codex. v1.2.17 closes that and restores
the Codex agentic path as primary.

Two pieces:

1. **`ensureCodexPlaywrightMcp`** appends a
   `[mcp_servers."playwright"]` section to `~/.codex/config.toml`
   so Codex sessions can use the Playwright browser-automation
   MCP. Same shape Codex already uses for the Threadline MCP.
   Idempotent — re-runs don't duplicate.

2. **`runTelegramAgentic`** spawns Codex with a Playwright-aware
   prompt that drives Telegram Web → BotFather → token capture →
   group creation → chat ID capture → config write. Long timeout
   (10 minutes) for the QR-code login. After the spawn ends,
   `verifyTelegramConfig` reads `.instar/config.json` directly
   and confirms `messaging[]` contains a telegram entry with both
   `token` and `chatId` populated. The action only returns
   `telegramConfigured: true` when the verifier passes.

The wizard's `setup-telegram-agentic` action now dispatches:

  try runTelegramAgentic →
    if verified: done
    else: dispatch falls through to runTelegramSetup
          (v1.2.15 readline backstop)

Both paths end at the same config state. The verifier prevents
the silent-success class of failure that broke v1.2.14.

Spec: `specs/dev-infrastructure/codex-playwright-telegram.md`.
ELI16: `specs/dev-infrastructure/codex-playwright-telegram.eli16.md`.
Side-effects: `upgrades/side-effects/feat-codex-playwright-telegram.md`.

## What to Tell Your User

The wizard's Telegram setup now tries to drive the bot creation
through a browser automatically when you're on the Codex runtime.
You'll see a browser window pop up; you may need to scan a QR code
from your phone to log into Telegram Web; then the wizard handles
BotFather, the bot token, the group creation, and the config
write. If anything along the way fails, the wizard drops to the
manual readline flow you saw in v1.2.15 — same end state, just
with you doing a couple of copy-pastes.

## Summary of New Capabilities

- Codex sessions now have Playwright MCP available (after running
  the wizard once or after an `instar setup` re-run).
- The Telegram setup step in the wizard automates more of itself
  on the Codex runtime.

## Evidence

Reproduction of the v1.2.14 silent-success class: ran v1.2.14
install, picked Codex, Telegram step recorded
`telegramConfigured: true` with empty messaging array. v1.2.15
fixed the silent success by switching to instar-native readline.
v1.2.17 restores the agentic path WITH the verifier, so the
silent-success class can't recur — `telegramConfigured: true`
requires the verifier to confirm the on-disk config write.

After fix:
- 18 new unit tests cover `buildTelegramAgenticPrompt`,
  `verifyTelegramConfig`, `ensureCodexPlaywrightMcp` (4 cases
  including idempotence + skip-when-codex-absent), and the
  dispatch order in `runAction`.
- Existing 37 wizard tests still pass.
- Manual end-to-end re-test on Codex install path pending on
  publish.
