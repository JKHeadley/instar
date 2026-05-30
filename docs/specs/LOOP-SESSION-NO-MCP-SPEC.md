---
title: Mentor loop session spawns with no project MCP (headless MCP-boot stall fix)
status: approved
review-convergence: converged
approved: true
approval-basis: >
  Live dogfood finding (Echo, 2026-05-30, topic 13435). After shipping the mentor
  autonomous-fix loop (#554, v1.3.109), I deployed it and ran a real cycle. The
  guardian spawned the Opus loop session correctly, but the spawned headless
  session HUNG ~4.5 min at 0.1% CPU on MCP-server boot and never processed its
  goal — the auth-required remote MCP servers in the project .mcp.json can't
  complete OAuth in a headless `claude -p` run. This is the "observe and fix as
  you go" loop Justin asked for (topic 13435: "replicate exactly what you've been
  doing... if it could just be you taking on that job") doing its job: the
  dogfood found a real bug in the feature, and this is the fix.
eli16-overview: LOOP-SESSION-NO-MCP-SPEC.eli16.md
date: 2026-05-30
---

# Mentor loop session spawns with no project MCP

## Problem

The mentor autonomous-fix loop (`mentor.autonomousFix`, #554) spawns a full-tool
Opus session per cycle via `SessionManager.spawnSession`. A headless one-shot
`claude -p` spawn inherits the project's `.mcp.json`, which for Echo includes
interactively-authenticated remote MCP servers (Fathom's `mcp-remote`, the
claude.ai connectors). Those can't complete their OAuth handshake in a headless
run, so the session never finishes booting MCP and never processes its prompt.

Verified live: the spawned loop session sat ~4.5 min at 0.1% CPU with no
transcript and a parked event loop (`_pthread_cond_wait`); the MCP child
processes (`@playwright/mcp`, `mcp-remote …fathom`) were alive at 0% CPU. The
guardian's spawn was otherwise correct — right model (opus), right full-tool
grant, the real dogfooding-loop goal — but the session was non-functional.

## Fix

Spawn the loop session with **no project MCP servers**. The claude CLI supports
`--strict-mcp-config` ("only use MCP servers from `--mcp-config`, ignoring all
other MCP configurations") and `--mcp-config` accepts an inline JSON string. An
empty strict config — `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` —
makes claude start with zero MCP servers. Verified: a headless spawn that
otherwise stalled now boots in ~9s.

The loop session needs none of those MCP servers: it drives the mentee over
Telegram (bash + the relay script / the mentor a2a HTTP), observes via the
filesystem + HTTP, and ships fixes with built-in tools (Bash/Edit/Read/Write +
git/gh via Bash). MCP is pure overhead for it, and the auth-required ones are an
active hazard.

### Components

- **`claudeHeadlessExtraFlags(opts)` (pure, `frameworkSessionLaunch.ts`)** — the
  single builder for the claude-code headless flags spliced before `-p`: the
  existing `--allowedTools` scope and the new `--strict-mcp-config` no-MCP spawn.
  Returns `[]` for non-claude frameworks or when neither is requested. Replaces
  the two inline splice blocks in `SessionManager` with one tested function.
- **`SessionManager.spawnSession({ disableProjectMcp })`** — a new opt-in option.
  When set on a claude-code spawn, the helper emits the no-MCP flags. Default
  unset ⇒ unchanged behaviour (project MCP loads as before).
- **`spawnLoopSession` (`AgentServer`)** — passes `disableProjectMcp: true`.

## Blast radius

- Only the mentor loop spawn opts in. Every other `spawnSession` caller
  (interactive sessions, mentee-handle, Stage-A, jobs) leaves `disableProjectMcp`
  unset ⇒ identical argv to today. Stage-A already runs MCP-free in practice
  (empty tool grant); regular sessions keep their MCP.
- Codex spawns are unaffected (the helper returns `[]` for non-claude).
- The `--allowedTools` behaviour is preserved exactly (same flags, now via the
  shared helper).

## Testing

- **Tier 1 unit** — `claude-headless-extra-flags.test.ts`: every branch of the
  helper (neither / allowlist only / MCP-disable only / both / empty allowlist /
  non-claude), including that the MCP config is a valid EMPTY config.
- **Tier 3 E2E** — `mentor-onboarding-lifecycle.test.ts` (extended): the REAL
  AgentServer production wiring spawns the loop session with
  `disableProjectMcp: true` (via the spy SessionManager), alongside the existing
  opus / full-tools / name / goal assertions.
- **Live re-dogfood** — after deploy, enable the loop, spawn a cycle, and confirm
  the session boots and works (no MCP stall) instead of hanging.

## Rollback

Revert the commit, or stop passing `disableProjectMcp`. No persisted state,
schema, config, or API contract changes.
