# Convergence Report — Codex+Playwright Telegram primary path

## ELI10 Overview

v1.2.15 made the wizard's Telegram setup a manual readline flow
because the previous Codex-driven attempt was broken — Codex didn't
have Playwright available. Justin pushed back: surely Codex has
the same browser-automation capabilities as Claude? Investigation
confirmed: yes, but instar wasn't registering Playwright for Codex
(only for Claude).

This PR fixes both halves: registers Playwright in `~/.codex/config.toml`
so Codex sessions can drive a browser, and restores the Codex-
agentic Telegram setup as the primary path with the v1.2.15
readline flow as a verified backstop. After the agentic Codex spawn
returns, instar reads `.instar/config.json` directly to verify the
write actually happened — never trusts Codex's exit code alone.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self + Justin's "why manual" push | 2 | Codex MCP registration + agentic path with verifier |
| 2         | (converged)           | 0                 | none |

## Full Findings Catalog

**Finding 1 — Codex couldn't see Playwright because the MCP wasn't
registered in ~/.codex/config.toml.**

- Severity: high (blocked the agentic Telegram path entirely).
- Resolution: new `ensureCodexPlaywrightMcp` helper appends the
  Playwright MCP section to ~/.codex/config.toml. Idempotent
  (matches both quoted and unquoted TOML section forms). Skips
  silently when Codex isn't installed.

**Finding 2 — The v1.2.14 agentic path silently succeeded when it
hadn't actually written config.**

- Severity: high (silent-success class).
- Resolution: `verifyTelegramConfig(projectDir)` reads
  `.instar/config.json` after the agentic spawn ends and confirms
  the messaging entry exists with both `token` and `chatId`
  populated. The action only returns `telegramConfigured: true`
  when the verifier passes. Otherwise dispatch falls through to
  the v1.2.15 readline backstop.

## Convergence verdict

Converged at iteration 2. Two scoped additions; existing primitives
only; no new abstraction layer; verifier-based success criterion
prevents regression. 18 new unit tests cover the prompt shape, the
verifier, and the Codex MCP registration helper.
