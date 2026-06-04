# vNEXT — plain English overview

## What this change is

Agents can now restart a sibling agent's server from inside their own session.

Before this change, the CLI blocked every `instar server start`, `stop`, or
`restart` command whenever it saw `INSTAR_SESSION_ID`. That was safe for the
agent's own server, because restarting the server that owns the current session
can strand the conversation. But it was too broad for mentorship and fleet work:
`instar server restart --dir gemini` was blocked even when Codey was trying to
bounce Gemini, a different agent.

This change makes that guard target-aware.

## What already existed

- A session guard in `src/cli.ts`.
- `--dir` and optional agent-name support on `instar server start|stop|restart`.
- Supervisor-managed server lifecycle via launchd/systemd.

## What's new

- A small guard helper compares the current session's project directory to the
  requested server target.
- If the target is a sibling agent, the command is allowed.
- If the target is the current agent, the command is still blocked.
- The self-target error now includes the concrete supervisor command:
  `launchctl kickstart -k gui/$UID/ai.instar.<name>`.
- The comparison resolves symlinks so an alias to the current project cannot
  bypass the self-restart protection.

## What you need to decide

Nothing. The safer behavior remains the default: an agent still cannot restart
the server that is managing its own active session.

## How to verify it worked after deploy

From inside Codey's session:

- `instar server restart --dir gemini` should proceed to Gemini's normal server
  restart path.
- `instar server restart` with no `--dir` should still be blocked for Codey's own
  server and should print the supervisor hint.

## Why this matters

This removes a real fleet-operations friction point without weakening the
original safety invariant. A mentoring agent can maintain a sibling agent, while
the current conversation remains protected from self-stranding restarts.

The CLI reference and README now also name the guard so the exported core helper
is covered by the docs-coverage gate.

Framework-ledger ref: `57ecfb92`.
