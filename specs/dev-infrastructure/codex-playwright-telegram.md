---
title: "Codex+Playwright Telegram setup (primary path)"
slug: "codex-playwright-telegram"
author: "echo"
eli16-overview: "codex-playwright-telegram.eli16.md"
review-convergence: "2026-05-22T01:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T01:30:00Z"
review-report: "docs/specs/reports/codex-playwright-telegram-convergence.md"
approved: true
---

# Codex+Playwright Telegram setup (primary path)

## Problem statement

v1.2.15 rewrote the wizard's Telegram setup as an instar-native
readline flow because the previous codex-exec attempt was broken
(Codex printed manual instructions and ended, leaving the channel
silently unconfigured). Justin pushed back on shipping that as the
default: *"surely codex has the same playwright capabilities as
claude code?"*

Investigation: yes, Codex CLI supports MCP tools (including
Playwright), but instar's `ensurePlaywrightMcp` only registered
Playwright in `~/.claude.json` and a project-local `.mcp.json` —
NEVER in `~/.codex/config.toml`. So the v1.2.14 codex-exec attempt
spawned with no Playwright reachable, fell back to printing manual
instructions, and ended.

The right shape: Codex+Playwright is the PRIMARY path; the v1.2.15
instar-native readline flow is the BACKSTOP.

## Proposed design

Two pieces, both in this PR.

### Fix 1: extend `ensurePlaywrightMcp` to cover Codex

New helper `ensureCodexPlaywrightMcp()` (exported for unit testing)
appended to `src/commands/setup.ts`'s ensurePlaywrightMcp flow:

```ts
function ensureCodexPlaywrightMcp(): void {
  const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(path.dirname(codexConfigPath))) return;  // Codex not installed
  // Idempotent check: skip if [mcp_servers."playwright"] already present
  // (matches both quoted and unquoted TOML forms).
  // Append the section atomically (tmp + rename).
}
```

Section appended:

```toml
[mcp_servers."playwright"]
kind = "stdio"
command = "npx"
args = ["-y", "@playwright/mcp@latest"]
```

This is the same shape Codex already uses for the Threadline MCP
that's registered on Justin's `~/.codex/config.toml` today (verified
by reading his config). TOML is appended hand-rolled rather than
parsed: we just check for the section header presence and append if
missing. Codex's config is regular TOML and an extra section at EOF
is a no-op for unrelated values.

### Fix 2: restore Codex-agentic Telegram setup as primary

New `runTelegramAgentic` in `src/commands/setup-wizard/codex-driver.ts`:

```ts
async function runTelegramAgentic(options): Promise<Partial<WizardAnswers>> {
  // Spawn `codex exec` with the Playwright-aware prompt.
  // 10-minute timeout (human-in-the-loop login).
  // After spawn returns, VERIFY config write via verifyTelegramConfig.
  // Only return telegramConfigured: true if verification passes.
}
```

The action's prompt (`buildTelegramAgenticPrompt`) is structured as:

1. Verify Playwright is reachable. If not, output the sentinel
   `PLAYWRIGHT_UNAVAILABLE` and exit. (Caller's fallback kicks in.)
2. Drive Telegram Web through QR-code login (snapshots every ~5s,
   120s timeout).
3. Open BotFather, `/newbot`, capture token from the reply.
4. Validate token via `curl /bot<TOKEN>/getMe`.
5. Create a new group, add the bot, send a first message.
6. Fetch chat ID via `curl /bot<TOKEN>/getUpdates`.
7. Write the canonical `{ type: 'telegram', enabled: true, config:
   { token, chatId, pollIntervalMs, stallTimeoutMinutes } }` to
   `.instar/config.json`.
8. On any unrecoverable failure, output `AGENTIC_FAILED: <reason>`
   and exit fast — fast-fail is what enables the fallback.

`verifyTelegramConfig(projectDir)` reads `.instar/config.json` and
returns true only when `messaging[]` contains a telegram entry with
both `token` and `chatId` populated. The action calls this AFTER
the spawn ends — never trusts Codex's exit code alone.

The dispatch in `runAction` becomes:

```ts
case 'setup-telegram-agentic': {
  const agentic = await runTelegramAgentic(options);
  if (agentic.telegramConfigured) return agentic;
  console.log(pc.dim('  Browser automation didn\'t finish — switching to manual setup.'));
  return await runTelegramSetup(options);  // v1.2.15 readline backstop
}
```

Both paths end at the same config state — the verifier guarantees
no silent-success on the agentic side.

## Decision points touched

- Adds one operator-intent SIGNAL (the choice to attempt agentic
  first). The state machine's `setup-telegram-agentic` action name
  is unchanged.
- AUTHORITY for "is Telegram actually configured" is now
  `verifyTelegramConfig` reading the on-disk config. The agentic
  spawn's exit code is necessary but not sufficient.
- No new permissions. Codex's spawn uses the same
  `--dangerously-bypass-approvals-and-sandbox` posture the agent's
  runtime uses (per `frameworkSessionLaunch.ts`); Playwright runs
  in its own browser sandbox.

## Open questions

None for this PR's scope.

## Out of scope

- WhatsApp + Slack agentic flows (still emit "configure later"
  pointers).
- A retry layer that re-attempts the agentic path on
  AGENTIC_FAILED with a different bot-username strategy. Today we
  fast-fail to the readline fallback after one agentic attempt.
- Validating that the user's Codex auth is configured (the spawn
  inherits the existing auth state; failures surface naturally).
