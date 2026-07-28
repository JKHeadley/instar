# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The mentor autonomous-fix loop now spawns its per-cycle session with NO project
MCP servers — fixing a headless boot-hang found by dogfooding the loop live.**

The loop (shipped dark in v1.3.109) starts a full-tool Opus session each cycle. A
headless `claude -p` spawn inherits the project `.mcp.json`, which includes
interactively-authenticated remote MCP servers (Fathom's `mcp-remote`, the
claude.ai connectors). Those can't complete their OAuth handshake headless, so
the session hung on MCP boot — observed live at ~4.5 min, 0.1% CPU, no transcript,
parked event loop — and never ran its cycle. The spawn was otherwise correct
(opus, full tools, the real goal); only MCP-loading jammed it.

The loop session now spawns with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`
(zero MCP servers). It needs none — it drives the mentee over Telegram and ships
fixes with built-in tools. A headless spawn that stalled now boots in ~9s. The
flag is opt-in (`spawnSession({ disableProjectMcp: true })`); every other spawn
keeps its MCP. The `--allowedTools` and new MCP-disable splices are unified in one
tested pure helper (`claudeHeadlessExtraFlags`).

## What to Tell Your User

Only relevant if you run the (off-by-default) mentor autonomous-fix loop. I
dogfooded it live and found its background worker session was hanging on startup
— it was trying to load login-required tools that can't sign in without a human,
so it froze before doing any work. I fixed it so the loop's worker starts with a
clean, minimal toolset and boots in seconds instead of hanging. Nothing changes
for any other session — they keep all their tools. This is the observe-and-fix
loop doing its job, just with me driving it this round.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| No-MCP headless spawn option | `spawnSession({ disableProjectMcp: true })` (opt-in; used by the mentor loop) |
| Mentor loop session boots reliably | Automatic when `mentor.autonomousFix.enabled` — no more MCP boot-hang |

## Evidence

- **Live reproduction (before):** the first real loop session (`mentor-autoloop-…`)
  spawned as `claude --dangerously-skip-permissions --model opus -p '…'` and sat
  ~4.5 min at 0.1% CPU, no transcript written, main thread in `_pthread_cond_wait`;
  child procs `@playwright/mcp` and `mcp-remote …fathom` alive at 0% CPU.
- **Fix verified (after):** `claude --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --model haiku -p '…'` in the same project returned in ~9s with no MCP boot.
- **Tests:** `tests/unit/claude-headless-extra-flags.test.ts` (6, every branch incl.
  the empty-MCP-config validity); `tests/e2e/mentor-onboarding-lifecycle.test.ts`
  (+1: the production loop spawn passes the no-MCP flag). Framework-launch
  regression suite (56) green. `tsc` + lint clean.
- Side-effects: `upgrades/side-effects/loop-session-no-mcp.md`. Spec:
  `docs/specs/LOOP-SESSION-NO-MCP-SPEC.md`.
