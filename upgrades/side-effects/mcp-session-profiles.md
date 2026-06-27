# Side-Effects Review — Per-session MCP profiles (dynamic-MCP lever 1)

**Version / slug:** `mcp-session-profiles`
**Date:** `2026-06-27`
**Author:** `echo`
**Tier:** 1 — a launch-time spawn-arg choice on the INTERACTIVE claude-code path. DARK by
default and DEFAULT-NO-OP (absent config ⇒ full `.mcp.json`, byte-for-byte today). No new
authority, route, or deletion. Touches the critical spawn function, so the no-op default +
fail-safe-to-full-set are the load-bearing safeties.

## Summary of the change

Lever 1 of the dynamic-MCP-lifecycle: launch a topic's interactive session with ONLY its
profiled MCP servers instead of the full project `.mcp.json`, cutting the heavy idle-MCP
footprint that dominated the 2026-06-26 panic. Files: `src/core/sessionMcpProfile.ts` (new
— pure `resolveMcpProfileServers` + `filterMcpConfig`), `src/core/SessionManager.ts` (a
private `buildSessionMcpProfileFlags` + a single injection in `spawnInteractiveSession`'s
claude-code branch), `src/core/types.ts` (`SessionManagerConfig.mcpProfiles`). Tests: 9
unit + 4 wiring.

## 1. Over-block (over-restrict a session's tools)

The risk that MATTERS: a session launched WITHOUT a server it needs. Mitigations: (a) the
feature is dark by default; (b) a topic gets the full set unless EXPLICITLY profiled — no
implicit restriction; (c) every failure path (feature off / no profile / missing or
unreadable `.mcp.json` / any throw) returns `[]` ⇒ the full `.mcp.json` ⇒ all tools. The
fail-safe ALWAYS points at "give it everything." Tested both sides (null ⇒ no flags; an
explicit list ⇒ exactly that subset).

## 2. Under-block

Not a gate — no under-block surface. The closest "miss" is a profiled topic still getting a
server it listed; the resolver is a pure pass-through of the configured allow-list.

## 3. Level-of-abstraction fit

Correct layer. Server selection is a launch-time decision, made where the launch argv is
assembled (`spawnInteractiveSession`), using the topic id already in scope
(`telegramTopicId`). The decision logic is isolated in a pure, fake-free-testable module;
SessionManager only does the I/O (read `.mcp.json`, write the filtered file, return flags).

## 4. Signal vs authority compliance

No block/allow surface. The profile is a launch-configuration input, not a gate; it can only
narrow a session's OWN tool set per explicit config, never block a message/session/action.

## 5. Interactions

- **Spawn paths:** wired ONLY into the interactive claude-code spawn (`spawnInteractiveSession`).
  The headless/job and rerouted lanes are untouched (jobs use the existing
  `disableProjectMcp` no-MCP path). Gated `framework === 'claude-code'`.
- **disableProjectMcp:** orthogonal — that path already strips MCP for jobs; the profile only
  applies on the interactive path that otherwise reads the full `.mcp.json`.
- **Per-session file:** a filtered copy is written under `<projectDir>/.instar/state/session-mcp-config/`
  per spawn; the source `.mcp.json` is NEVER mutated. (Cleanup of stale filtered files is a
  tracked minor follow-up; they are tiny JSON and overwritten by topic+timestamp.)

## 6. External surfaces

- No new route, credential, or external call. The only new I/O is reading the project
  `.mcp.json` and writing a filtered copy locally (jailed under the agent home).
- Config: `sessions.mcpProfiles` (dark). No migration needed (absence ⇒ no-op via `?? `/null).

## 7. Rollback

Pure additive code + one config block. `sessions.mcpProfiles.enabled` unset/false ⇒ full
`.mcp.json` verbatim. Reverting the commit removes the path entirely.

## Known follow-ups (tracked, not in this increment)

- Lever 2 (idle-live MCP offload) — the runtime reclaimer, gated on a mid-tool-use check.
- Stale filtered-config-file cleanup.
- Wiring the same profile into the rerouted-interactive job lane if/when those need it.
