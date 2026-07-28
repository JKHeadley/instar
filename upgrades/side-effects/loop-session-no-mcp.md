# Side-effects review — Mentor loop session spawns with no project MCP

**Spec:** `docs/specs/LOOP-SESSION-NO-MCP-SPEC.md`
**Change:** the mentor autonomous-fix loop spawns its per-cycle Opus session with
no project MCP servers, so a headless spawn doesn't hang on auth-required remote
MCP boot. Found by the live dogfood of the loop (#554).
**Class:** mentor-loop reliability fix (the feature ships dark).

## What changed

- **`src/core/frameworkSessionLaunch.ts`** (+1 export) — `claudeHeadlessExtraFlags(opts)`:
  the single pure builder for the claude-code headless flags spliced before `-p`
  (the existing `--allowedTools` scope + the new `--strict-mcp-config --mcp-config
  '{"mcpServers":{}}'` no-MCP spawn). Returns `[]` for non-claude / no options.
- **`src/core/SessionManager.ts`** — new opt-in `spawnSession({ disableProjectMcp })`;
  the two inline flag-splice blocks (`--allowedTools` + the new MCP-disable) are
  replaced by one call to `claudeHeadlessExtraFlags`.
- **`src/server/AgentServer.ts`** — `spawnLoopSession` passes `disableProjectMcp: true`.

## Blast radius

- **Other spawn callers:** unchanged. `disableProjectMcp` is opt-in (default
  unset). Interactive sessions, mentee-handle spawns, Stage-A, and jobs leave it
  unset ⇒ byte-identical argv to today (project MCP loads as before).
- **`--allowedTools` behaviour:** preserved exactly — same flags, now built by the
  shared helper instead of an inline splice. Covered by the existing
  framework-launch unit suite (56 tests still green) + the new helper test.
- **Codex spawns:** unaffected — the helper returns `[]` for non-claude
  frameworks (Codex MCP wiring is separate, via sandbox modes).
- **MCP for the loop session:** the loop drives the mentee over Telegram (bash +
  relay / a2a HTTP) and ships fixes with built-in tools — it used no MCP, so
  removing it has no functional loss, only removes the boot hazard.

## What could break (and why it doesn't)

- **Loop needs an MCP tool?** It doesn't — it uses built-in Bash/Edit/Read/Write
  + git/gh via Bash, and Telegram via the relay script. If a future loop variant
  needs a specific MCP, pass a curated `--mcp-config` rather than the project one.
- **`--mcp-config` inline-string support?** Verified against the installed claude
  CLI: `--mcp-config '{"mcpServers":{}}'` is accepted and starts zero servers
  (a headless `-p` run that otherwise stalled booted in ~9s).
- **Splice position?** The helper's flags are spliced before `-p` exactly like the
  prior `--allowedTools` code; argv structure is unchanged otherwise.

## Security

No new external input / network / auth / fs surface. The change REMOVES MCP
servers from one spawn path (strictly fewer external connections). The empty MCP
config is a constant inline string.

## Migration parity

Server-internal session-spawn code — every agent gets it by running the new
build. No config, schema, hook, or CLAUDE.md change. No PostUpdateMigrator entry.

## Rollback

Revert the commit, or stop passing `disableProjectMcp`. No persisted state.

## Tests

`tests/unit/claude-headless-extra-flags.test.ts` (+6): every helper branch incl.
the empty-MCP-config validity. `tests/e2e/mentor-onboarding-lifecycle.test.ts`
(+1 assertion): the production loop spawn passes `disableProjectMcp: true`.
Framework-launch regression suite (56 tests) green. `tsc` + `npm run lint` clean.
