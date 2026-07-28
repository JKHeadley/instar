---
title: Codex Multi-Agent Threadline Robustness
status: approved
approved: true
approver: justin
approved-at: "2026-05-24T19:48:00Z"
review-convergence: "2026-05-24T19:48:00Z"
review-iterations: 1
review-report: "docs/specs/reports/codex-multiagent-threadline-convergence.md"
created: 2026-05-24
owner: echo
companion-eli16: CODEX-MULTIAGENT-THREADLINE-ELI16.md
eli16-overview: CODEX-MULTIAGENT-THREADLINE-ELI16.md
---

# Codex Multi-Agent Threadline Robustness

## Problem

Two distinct, independently-verified defects prevent a Codex-framework instar
agent from replying to inbound Threadline messages. Both were found live on
`instar-codey` while completing the relay round-trip test (topic 12304); both
are framework-integration bugs in instar (Echo's domain), not config errors.

### Defect A — headless Codex launch cancels MCP tool calls

`buildHeadlessLaunch` (`src/core/frameworkSessionLaunch.ts`) defaulted Codex to
`-s workspace-write`. Under that profile `codex exec` defaults its approval
policy to `never`, and `never` does not mean "auto-approve" — it means "refuse
anything that would need approval." MCP tool calls need approval, so codex
**silently cancels** them: `{"Err":"user cancelled MCP tool call"}`.

When a Threadline message arrives, instar spawns a headless worker prompted to
reply via the `threadline_send` MCP tool (`ThreadlineRouter`, ~line 162). The
worker received the message, found the tool, and called it with correct
arguments — but the call was cancelled twice, so no reply was ever sent
(verified in the codex rollout log, 2026-05-24).

The **interactive** builder (`buildInteractiveLaunch`) already defaults to
`--dangerously-bypass-approvals-and-sandbox` (which permits MCP calls). The
headless builder diverged. That asymmetry is the bug.

### Defect B — shared `~/.codex/config.toml` last-writer-wins collision

`ThreadlineBootstrap.registerThreadlineMcp` registers
`[mcp_servers."threadline"]` into `~/.codex/config.toml` at **user scope** with
the booting agent's `--state-dir`/`--agent-name` baked into `args`. That file is
shared by every Codex agent on the machine. Each agent's boot overwrites the
single shared table, so only the **last-booted** Codex agent's threadline MCP is
active; every other Codex agent's `threadline_send` loads the wrong agent's
identity/server. Observed live: the shared entry pointed at `inspec`
(monroe-workspace) while `instar-codey` was the agent actually running.

## Fix

### Fix A — targeted MCP-permitting launch (reply workers only)

`buildHeadlessLaunch` for `codex-cli` selects the launch profile in three tiers:
- explicit `codexSandboxMode` → `-s <mode> --ask-for-approval never`;
- `codexAllowMcpTools: true` (Threadline reply workers) →
  `--dangerously-bypass-approvals-and-sandbox` (the ONLY mode that permits MCP
  tool calls — see Convergence findings);
- default (scheduled JOBS, dispatch, etc.) → `-s workspace-write` (unchanged
  from prior behavior — jobs stay sandboxed).

`codexAllowMcpTools` is set ONLY by the two Threadline inbound-reply spawn paths
(see Fix C). Jobs never set it, so the security posture for scheduled work is
unchanged.

### Fix C — both reply paths wired

Threadline has TWO inbound-reply spawn paths and BOTH must carry
`codexAllowMcpTools: true` + the per-agent MCP override:
- the full-session path: `SpawnRequestManager.spawnSession` callback
  (`server.ts` `msg-spawn-*`) → `SessionManager.spawnSession`;
- the lightweight path: `PipeSessionSpawner` (used when a message classifies as
  a simple "pipe" reply; its prompt is "Reply ONLY via the threadline_send
  tool"), which calls `buildHeadlessLaunch` directly.

### Fix B — per-spawn MCP override (per-agent isolation)

New single-source-of-truth resolver `src/threadline/mcpEntry.ts`
(`resolveThreadlineMcpEntry`) returns the `{command, args}` for an agent's
threadline MCP stdio entry. `ThreadlineBootstrap` uses it for registration.
At server boot, `server.ts` computes this agent's entry and threads it through
`SessionManagerConfig.codexThreadlineMcp`; the codex launch builders emit
`-c mcp_servers.threadline.{command,args,kind}=…` per spawn. Codex's `-c`
overrides win over the shared `~/.codex/config.toml`, so each agent's codex
session uses ITS OWN threadline MCP regardless of which agent last wrote the
shared file. Non-codex launches ignore the option; codex agents without
threadline configured pass `undefined` (no override emitted).

This does not remove the shared-config registration (kept for discoverability /
Claude parity) — it makes it non-authoritative for codex spawns by overriding
per-invocation. `codex -c` accepts nested-table + array values (verified against
codex 0.133).

## Signal vs authority

No fix adds a brittle check with blocking authority. Fix A is a launch-profile
selection (no gate). Fix B/C are launch-argument computations. The
`config.threadline`-present and `codexAllowMcpTools` conditions are capability
selectors, not authority gates.

## Convergence findings (2026-05-24, two-reviewer pass)

1. **(adopted) Don't unsandbox jobs.** An earlier cut defaulted ALL headless
   codex spawns to bypass, which unsandboxes scheduled JOBS (they ingest
   external content → prompt-injection exposure). Resolved: bypass is now scoped
   to reply workers via `codexAllowMcpTools`; jobs keep `workspace-write`.
2. **(verified) No sandboxed MCP path exists.** A reviewer suggested keeping the
   sandbox + a permissive approval policy. Empirically false on codex 0.133:
   under `-s workspace-write` the threadline MCP tool is unavailable/cancelled
   (the sandbox blocks the MCP server's localhost transport AND `never` cancels
   the call). Full bypass is the only mode that lets a reply worker call
   `threadline_send`. This is why Fix A scopes bypass rather than seeking a
   sandboxed middle ground.
3. **(adopted) Second reply path.** `PipeSessionSpawner` is a real reply path
   that also uses `threadline_send`; it was unwired. Fix C wires both paths.
4. **(checked) `-c` injection safety.** `agentName`/`stateDir` are
   operator-controlled and passed as argv array elements (no shell) in the
   SessionManager/tmux path; `JSON.stringify` produces valid TOML-array values
   for codex's `-c` parser (verified). The PipeSessionSpawner path shell-quotes
   each argv element, preserving the JSON intact.

## Security posture (requires sign-off — approved by operator)

A codex agent's Threadline reply worker MUST run under
`--dangerously-bypass-approvals-and-sandbox` to call `threadline_send` — there
is no sandboxed mode that permits the MCP call (finding 2). The reply worker
processes an INBOUND message, but Threadline only delivers messages from
**trusted** agents (trust-gated), so the exposure is bounded to trusted peers.
The alternative — "codex agents can receive but never auto-reply" — defeats the
feature. Operator accepted this tradeoff (topic 12304, 2026-05-24). Scheduled
jobs remain sandboxed; only reply workers take the bypass.

## Acceptance criteria

1. `buildHeadlessLaunch('codex-cli', …)` with no flags → `-s workspace-write`
   (jobs stay sandboxed), NOT bypass.
2. `codexAllowMcpTools: true` → `--dangerously-bypass-approvals-and-sandbox`
   (reply workers); explicit `codexSandboxMode` wins over it →
   `-s <mode> --ask-for-approval never`.
3. With `codexThreadlineMcp` set, codex builders emit
   `-c mcp_servers.threadline.command/args/kind`, args being valid JSON, before
   the positional prompt; claude-code ignores both options.
4. `resolveThreadlineMcpEntry` is the single source of truth; distinct agents
   resolve distinct identity args.
5. BOTH reply paths (SessionManager `msg-spawn` + `PipeSessionSpawner`) pass
   `codexAllowMcpTools` + the per-agent override; jobs/dispatch do not.
6. Live: a Codex agent receiving a Threadline message replies via
   `threadline_send` (mechanism verified — see Evidence; full deployed
   round-trip is the post-merge Tier-3 acceptance).
7. Full suite green; migration-parity covered (existing agents get the launch
   fix on update with no config change required).

## Evidence (verified before this spec)

- Defect A reproduced + fixed: a `codex exec --dangerously-bypass-approvals-and-
  sandbox` run successfully completed a `threadline_send` MCP call (codey→echo,
  reply received). Under `-s workspace-write` the same call was cancelled.
- Defect B observed: `~/.codex/config.toml` `[mcp_servers."threadline"]` pointed
  at `inspec` while `instar-codey` was running.
- Unit tests: `frameworkSessionLaunch.test.ts` (headless bypass default +
  override emission), `threadline-mcp-entry.test.ts` (resolver). Green.

## Rollback

Code-only, no migration/state changes. Revert `frameworkSessionLaunch.ts`
(restores prior headless default + drops `-c` emission), `mcpEntry.ts`,
`ThreadlineBootstrap` refactor, `server.ts`/`SessionManager`/`types.ts` wiring.
The shared-config registration is unchanged, so reverting cannot strand state.

## Testing

- Unit (Tier 1): launch builders + resolver (above).
- Migration parity: launch-path fix ships to existing agents via normal update
  (no `.instar` config or `~/.codex` rewrite needed — the override is computed
  at boot from existing config).
- Live (Tier 3, real-world): codex round-trip reply through the deployed relay.
