# Shared Codex config is written only on request

## What Changed

The server no longer writes `[mcp_servers."threadline"]` into the shared Codex user config
(`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`) at boot. That file is one per
user, so the boot write was last-writer-wins across every agent on the machine and across
the test suite (2026-10-20: an e2e boot rewrote the operator's real file). Codex sessions
Instar launches never needed it — each already gets its own agent's entry per session via
`-c mcp_servers.threadline.*`. A new command, `instar codex connect <agent>`, writes the entry
on request for a Codex the operator starts by hand (`--dry-run` previews; `CODEX_HOME` honored).
The shared test setup now forces `CODEX_HOME` onto a temp dir for every test process, every
test that boots Threadline in-process moves `HOME` to a temp dir, and a guard test keeps both
rules enforced.

## What to Tell Your User

If you start Codex yourself in a terminal and want it to have this agent's Threadline tools,
ask me to connect it and I will run the connect command for my own name. The setting lives in
one file shared by every Codex on your machine, so it names one agent at a time; connecting
another agent replaces it. The Codex sessions I launch are not affected either way.

## Summary of New Capabilities

- `instar codex connect <agent>` — connect a hand-started Codex to one agent's Threadline MCP
  server (explicit, idempotent, keeps your other Codex settings; `--dry-run` to preview).

## Evidence

- `tests/unit/codex-connect-command.test.ts`: agent-home resolution (registry path, then the
  convention location), TOML shape, idempotency, visible last-writer-wins, preserved operator
  content, dry-run writes nothing, refusals for unknown or malformed names.
- `tests/unit/threadline-codex-mcp-registration.test.ts`: `bootstrapThreadline()` leaves an
  existing `$CODEX_HOME/config.toml` byte-identical.
- `tests/unit/test-setup-hermetic-codex-home.test.ts`: the suite's `CODEX_HOME` is a temp dir,
  a user-scope registration lands there and the real file is unchanged, and every test that
  imports `bootstrapThreadline` isolates `HOME`.
- `tests/unit/PostUpdateMigrator-codexConnect.test.ts`: template + migration parity, idempotent,
  framework-shadow marker present.
- `tests/integration/codex-connect-cli.test.ts`: the real `dist/cli.js` connect, dry-run, and
  not-installed exit path.
- `tests/e2e/codex-connect-lifecycle.test.ts`: boot writes nothing, connect writes once, and a
  second agent's Instar-launched Codex session still carries its own override.
