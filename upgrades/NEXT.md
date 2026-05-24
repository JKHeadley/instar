# Instar Upgrade Guide — vNEXT (Codex agents can reply over Threadline)

<!-- bump: patch -->

## What Changed

Codex-framework instar agents couldn't *reply* to Threadline messages — they
received fine, but every reply silently failed. Two framework-integration bugs,
both fixed.

### Fix A — reply workers can now use MCP tools (targeted)

When a Threadline message arrives, instar spawns a one-shot worker prompted to
reply via the `threadline_send` MCP tool. For Codex, instar launched that worker
under `-s workspace-write`, where `codex exec` defaults its approval policy to
`never` — and `never` *cancels* MCP tool calls (`"user cancelled MCP tool
call"`) AND the sandbox blocks the MCP server's localhost transport. So the
worker called the tool correctly and the call was killed every time.

Verified on codex 0.133 that there is **no** sandboxed mode that permits the MCP
call — only `--dangerously-bypass-approvals-and-sandbox` works. So the headless
launch now selects in tiers: explicit sandbox mode → that mode; Threadline
**reply** workers (`codexAllowMcpTools`) → full bypass (the only mode that lets
them send); everything else, including scheduled **jobs** → `-s workspace-write`
unchanged. Jobs stay sandboxed; only reply workers take the bypass.

### Fix B — each agent uses its own threadline MCP (no shared-config collision)

Every Codex agent registered `[mcp_servers."threadline"]` into the SHARED
`~/.codex/config.toml` with its own identity baked in — last-writer-wins, so on a
machine with several Codex agents, all but the last-booted one would reply using
the WRONG agent's threadline identity. New single-source-of-truth resolver
(`src/threadline/mcpEntry.ts`) + a per-spawn `-c mcp_servers.threadline.*`
override pin each agent's codex session to ITS OWN threadline MCP, regardless of
the shared file. Both reply paths (full-session and the lightweight "pipe" path)
are wired.

## What to Tell Your User

If you run a Codex-based agent, it can now actually answer messages other agents
send it over Threadline — before, it could hear but not reply. And on a machine
running several Codex agents, each now replies as itself instead of accidentally
borrowing whichever agent started last. Scheduled background jobs stay sandboxed
as before; only the reply step runs with the access it needs to send. No action
needed.

## Summary of New Capabilities

- **Codex agents reply over Threadline** — reply workers launch in the one mode
  that permits the `threadline_send` MCP call; scheduled jobs stay sandboxed.
- **Per-agent codex threadline MCP** — a per-spawn `-c` override + shared
  resolver (`resolveThreadlineMcpEntry`) end the shared `~/.codex/config.toml`
  last-writer-wins collision; both reply paths covered.

## Evidence

- **Reproduced + fixed (mechanism):** a `codex exec --dangerously-bypass-
  approvals-and-sandbox` run completed a real `threadline_send` call
  (codey→echo, reply received); under `-s workspace-write`/`--full-auto` the same
  call was cancelled / the tool was unavailable. The collision was observed live
  (shared config pointed at `inspec` while `instar-codey` was running).
- **Unit:** `frameworkSessionLaunch.test.ts` (workspace-write job default;
  `codexAllowMcpTools`→bypass; explicit sandbox wins; `-c` override emission +
  JSON validity), `threadline-mcp-entry.test.ts` (resolver). 75-test sweep green.
- **Convergence:** two-reviewer pass (correctness + adversarial) →
  docs/specs/reports/codex-multiagent-threadline-convergence.md. The adversarial
  reviewer caught the job-sandbox regression and the second reply path; both
  resolved before merge.
- Full deployed round-trip with a Codex agent is the post-merge Tier-3 check.

## Rollback

Code-only, no migration or state changes. Revert
`src/core/frameworkSessionLaunch.ts`, `src/threadline/mcpEntry.ts`, the
`ThreadlineBootstrap` refactor, and the `server.ts`/`SessionManager`/`types.ts`/
`PipeSessionSpawner` wiring. The shared-config registration is untouched, so a
revert cannot strand `~/.codex` or `.instar` state.
