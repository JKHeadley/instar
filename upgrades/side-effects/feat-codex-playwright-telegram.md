# Side-effects review — Codex+Playwright Telegram primary path

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER. v1.2.15 only offered the instar-native readline
Telegram flow because Codex+Playwright was demonstrably broken.
That worked but felt manual to users on a runtime designed to
automate.

After: precisely targeted. Codex+Playwright is the primary path;
the readline flow is the backstop. Users on Codex runtime get
automated bot creation when Playwright is reachable; everyone
falls back to manual when it isn't.

No over-block: the readline flow is unchanged (still serves as
backstop), Claude wizard untouched, WhatsApp/Slack untouched.

## 2. Level-of-abstraction fit

Two scoped additions:

- `ensureCodexPlaywrightMcp()` in `src/commands/setup.ts` — a
  sibling of the existing claude/.mcp.json registrations. Same
  abstraction layer (idempotent file writers for MCP config).
- `runTelegramAgentic` + `buildTelegramAgenticPrompt` +
  `verifyTelegramConfig` in `src/commands/setup-wizard/codex-
  driver.ts` — sit alongside the existing `runTelegramSetup`
  (instar-native flow). Both are private to the driver module.

The dispatch in the setup-telegram-agentic action case is the
single coordination point: agentic first, native backstop on
verification failure.

## 3. Signal vs Authority compliance

- The agentic spawn's exit code is a SIGNAL.
- `verifyTelegramConfig` reading `.instar/config.json` is the
  AUTHORITY. The action only returns `telegramConfigured: true`
  when the AUTHORITY confirms the on-disk state.
- `PLAYWRIGHT_UNAVAILABLE` / `AGENTIC_FAILED: <reason>` are
  conventional sentinels the Codex prompt emits — the dispatch
  doesn't parse them programmatically (the verifier does the
  authoritative check) but they help the operator debug.
- TOML section presence in `~/.codex/config.toml` is the
  AUTHORITY for "is Playwright registered for Codex." The
  idempotence check looks for the literal section header.

## 4. Interactions with adjacent systems

- **`ensurePlaywrightMcp`**: extended (not replaced). The new
  `ensureCodexPlaywrightMcp` is called at the end of its body. The
  Claude-side registration is unchanged.
- **`~/.codex/config.toml`**: appended to (idempotent). Other
  sections preserved verbatim. The new section follows the same
  shape Codex uses for Threadline.
- **`runTelegramSetup` (v1.2.15)**: unchanged. Now serves as the
  backstop reached on verification failure.
- **State machine `setup-telegram-agentic` action**: name
  unchanged. Dispatch handler in `runAction` is the only edited
  case.
- **Codex spawn flags**: the agentic spawn uses
  `--dangerously-bypass-approvals-and-sandbox` (matches the
  agent's runtime spawn in `frameworkSessionLaunch.ts`),
  `-m WIZARD_CODEX_MODEL` (matches the narrative spawn), and
  `--skip-git-repo-check` (allows running outside a git repo).
- **Existing dispatch canary test**: still asserts every codex
  exec spawn in the driver carries `-m WIZARD_CODEX_MODEL`. The
  new agentic spawn obeys this.
- **`PostUpdateMigrator`**: not touched. `ensurePlaywrightMcp` is
  called by `runSetup` (Phase 2.5 in the wizard), not by the
  installer. Existing agents that re-run `npx instar setup` pick
  up the Codex registration automatically.

## 5. Rollback cost

Low. Revert restores v1.2.16 (agentic Telegram path removed,
readline flow as sole option). The Codex MCP registration block
appended to `~/.codex/config.toml` is harmless if left in place
after rollback (no one will spawn the agentic path).

## 6. Backwards compatibility / drift surface

Fully backwards-compatible.

- Codex-runtime users: get automated bot creation if Playwright
  works, manual flow if not. Strictly better than v1.2.15's
  manual-only.
- Claude-runtime users: zero change.
- Codex users without Codex installed at MCP-registration time:
  `ensureCodexPlaywrightMcp` skips silently (no
  `~/.codex/` directory).
- API-key Codex users: same auth posture (no new env vars, no new
  flags).
- No config schema change. No agent-installed-files change. No
  `PostUpdateMigrator` work needed (`ensurePlaywrightMcp` runs in
  the wizard, not the installer).

Drift surface: the Codex MCP TOML format. Verified against
Justin's live `~/.codex/config.toml` (Threadline registration uses
exactly the same shape). If Codex changes the format, the
idempotence check + append both need updates. Captured in the
spec's "out of scope" — a v2 of this PR could swap the hand-rolled
TOML for a proper parser.

## 7. Authorization / Trust posture

No new authority. The Codex agentic spawn uses the same sandbox-
bypass posture the agent's runtime already uses (per
frameworkSessionLaunch.ts). Playwright operates in its own
browser sandbox via MCP. The Telegram Bot API calls happen with
the user's bot token (same as the v1.2.15 readline flow).

## Outcome

Ship. Restores Codex+Playwright as the primary Telegram setup
path while keeping the v1.2.15 readline flow as a verified
backstop. Closes Justin's concern about why we were making the
user do this manually on a runtime designed to automate.
Verifier-based success criterion prevents any silent-success
regression of the v1.2.14 class.
