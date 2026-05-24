# Side-Effects Review — Codex Multi-Agent Threadline Robustness

Spec: docs/specs/CODEX-MULTIAGENT-THREADLINE-SPEC.md (approved, converged)
Change: let Codex-framework agents reply to Threadline messages — (A) targeted
MCP-permitting launch for reply workers, (B) per-agent threadline MCP override,
(C) wire both reply paths.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

None new. The launch-profile selector is additive: jobs keep `-s
workspace-write` (unchanged); reply workers add bypass; explicit
`codexSandboxMode` still wins. The `-c` MCP override only ever points codex at
THIS agent's own threadline entry — it cannot reject anything.

## 2. Under-block — what failure modes does this still miss?

- Codex agents without threadline configured: no override emitted (correct — no
  threadline to reply through). Not a miss.
- The reply worker still depends on the deployed relay / local delivery being
  reachable — out of scope here (transport already works).
- A future THIRD reply path that calls `buildHeadlessLaunch` directly would need
  the same two flags. Mitigated by routing all reply spawns through the two
  known paths; documented in the spec.

## 3. Level-of-abstraction fit

Correct layer. The launch-profile + MCP-override are properties of HOW a codex
session is launched → they belong in `frameworkSessionLaunch` (the builder) with
the data computed once at boot in `server.ts`. The single-source-of-truth
resolver (`mcpEntry.ts`) is shared with `ThreadlineBootstrap` so registration and
per-spawn override cannot drift.

## 4. Signal vs authority compliance

Compliant. No blocking authority added. The selectors (`codexAllowMcpTools`,
`codexThreadlineMcp`, `config.threadline`-present) are capability/launch choices,
not gates that block information flow. See docs/signal-vs-authority.md.

## 5. Interactions

- Fix A ↔ Fix B: independent (sandbox profile vs MCP entry); both emitted in the
  same codex argv, no conflict.
- Fix B ↔ existing shared-config registration: intentional — `-c` wins per spawn;
  the shared `~/.codex/config.toml` entry stays (Claude parity / discovery) but
  is non-authoritative for codex spawns. No double-fire (one MCP server named
  "threadline" results).
- Jobs/dispatch (routes.ts generic spawn, JobScheduler): do NOT set
  `codexAllowMcpTools` → unchanged (`workspace-write`). No shadowing.
- ThreadlineBootstrap refactor is behavior-preserving (`resolveThreadlineMcpEntry`
  returns the identical `{command,args}`; `absDir` still declared for downstream
  ~/.claude.json registration).

## 6. External surfaces

- Other agents: a codex agent can now actually reply over Threadline — net new
  outbound it previously couldn't send. Bounded by the trust gate (replies only
  to trusted peers, who already messaged it).
- Security posture: codex reply workers run unsandboxed (full bypass) — the only
  mode that permits the MCP call (verified, finding 2). Scheduled jobs remain
  sandboxed. Operator signed off (topic 12304).
- Timing/runtime: none introduced; the override is computed once at boot.

## 7. Rollback cost

Code-only, no migration/state. Revert `frameworkSessionLaunch.ts`, `mcpEntry.ts`,
`ThreadlineBootstrap` refactor, `server.ts`/`SessionManager`/`types.ts`/
`PipeSessionSpawner` wiring. The shared-config registration is untouched, so a
revert cannot strand `~/.codex` or `.instar` state. Existing agents pick up the
launch fix on normal update (no config rewrite).
