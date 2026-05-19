---
title: "Framework-aware Threadline MCP registration (portability Gap 2)"
slug: "portability-codex-mcp"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "portability-codex-mcp.eli16.md"
review-convergence: "2026-05-19T21:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T21:30:00Z"
review-report: "docs/specs/reports/portability-codex-mcp-convergence.md"
approved: true
approved-by: "Justin (pre-authorized 2026-05-19, autonomous-mode; directed empirical discovery of Codex specs via the live ~/.codex/)"
approved-date: "2026-05-19"
approval-note: "Gap 2 of six — the final code gap. Codex MCP format/path empirically verified from live ~/.codex/ (config.toml, [mcp_servers.*]) and our own mcpToolRegistry.ts docs. Ships v1.0.13. Only Gap 6 (architecture decision) remains, deferred to operator review by design."
lessons-engaged:
  - "P1 (Structure>Willpower): registration writes the Codex config structurally; not a doc telling operators to add it."
  - "P4 (Testing Integrity): 4-case test pinning the Codex TOML shape, idempotency, operator-content preservation, isRegistered."
  - "P10 (Comprehensive-First): reuses the existing OpenAiCodexMcpToolRegistry — no duplicate TOML writer; both Claude paths preserved."
  - "Trust-Verify-Improve: Codex MCP path/format verified from live ~/.codex/ AND our own codebase docs — no fabrication."
  - "L1-equivalent (audit-driven): closes verified Gap 2."
  - "L6/L9/L10: siblings."
---

# Framework-aware Threadline MCP registration (Gap 2)

## Problem

`ThreadlineBootstrap.registerThreadlineMcp` registered the Threadline MCP
server only into Claude Code config (`~/.claude.json` + project `.mcp.json`).
A Codex agent that joined the Threadline network had the relay running but
**no MCP tools advertised to its runtime** — `threadline_discover`,
`threadline_send`, etc. were unreachable from Codex.

## Empirical grounding (not guessed)

Codex MCP servers are `[mcp_servers."<id>"]` TOML tables in
`~/.codex/config.toml` (project scope: `.codex/config.toml`). Verified two
ways: (1) our own codebase already documents this in
`src/providers/primitives/integration/mcpToolRegistry.ts:7`; (2) inspected
against the live `~/.codex/config.toml` on disk (Codex CLI 0.78.0).

## Change

`registerThreadlineMcp` is now `async` (the one call site in
`bootstrapThreadline` now awaits it). After the two unchanged Claude
registration blocks, it adds a third: when `~/.codex/` exists (Codex
installed on this host), it registers the same stdio spec via the
**existing** `OpenAiCodexMcpToolRegistry` (`createMcpToolRegistry()`), which
performs an idempotent remove-then-append of the `[mcp_servers."threadline"]`
table in `~/.codex/config.toml`.

Design decisions:

- **Reuse, don't duplicate.** The Codex TOML writer already exists and is
  tested; this PR calls it rather than hand-rolling TOML, so the two cannot
  drift.
- **Gated on `~/.codex/` existing.** A Claude-only host is never given a
  Codex config it does not use (consistent with the lockdown ethos of not
  writing configs an install doesn't need).
- **Non-fatal.** Wrapped in try/catch like the existing Claude blocks — a
  Codex registration failure never breaks Claude registration or bootstrap.
- **Idempotent.** The registry removes any existing `threadline` table
  before appending, and preserves unrelated operator content.

## What this is NOT

- Not a change to Claude registration — both Claude blocks are byte-identical.
- Not an enabledFrameworks-gated change — Codex registration follows
  Codex-installed-presence, which is the right signal for "does this host
  have a Codex runtime to advertise tools to."

## Testing

`tests/unit/threadline-codex-mcp-registration.test.ts` — 4 cases against a
`CODEX_HOME` override: writes the stdio table; idempotent (no duplicate
table on re-register); preserves unrelated operator `config.toml` content;
`isRegistered` reflects state. ThreadlineBootstrap regression suite green.

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ structural registration |
| P4 Testing Integrity | ✓ 4 cases, idempotency + operator-preservation |
| P6 Zero-Failure | ✓ suite green |
| P10 Comprehensive-First | ✓ reuses tested registry; no duplication |
| Trust-Verify-Improve | ✓ format verified live + in-codebase |
| L6/L9/L10 | ✓ siblings |

No contradictions. No fabrication.

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `src/threadline/ThreadlineBootstrap.ts` — async registerThreadlineMcp +
   Codex registration block + awaited call site.
3. `tests/unit/threadline-codex-mcp-registration.test.ts` (NEW, 4 tests).
4. `upgrades/NEXT.md` + `upgrades/side-effects/feat-portability-codex-mcp.md`.
