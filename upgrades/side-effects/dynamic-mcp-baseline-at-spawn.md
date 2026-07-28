# Side-effects review — dynamic-MCP baseline-at-spawn wiring

**Change:** Wire the dynamic-MCP launch-set resolver into the real interactive
spawn path so a claude-code session can launch with a lean/explicit MCP subset
instead of the full `.mcp.json`. Three edits:
- `src/core/frameworkSessionLaunch.ts` — add `mcpFlags?: string[]` to
  `InteractiveLaunchOptions`; `claudeCodeBuilder` pushes them into argv (right
  before returning). Empty/absent ⇒ no flags ⇒ full `.mcp.json` (the default).
- `src/core/SessionManager.ts` — new fail-safe private `buildSessionMcpFlags(topicId,
  framework)` (reads `.mcp.json` + the committed loaded-set state file,
  `resolveSessionMcpServers` → `filterMcpConfig` → writes a unique filtered config,
  seeds the committed state file from baseline when absent); wired into the
  `buildInteractiveLaunch` call via a spread.
- `src/core/types.ts` — `SessionManagerConfig.dynamicMcp?` config field (type-only,
  NOT in ConfigDefaults).

## 1. Blast radius
**Zero while dark** (the default). `buildSessionMcpFlags` returns `[]` on the FIRST
line when `dynamicMcp.enabled !== true`, so no `mcpFlags` are passed, so
`claudeCodeBuilder` pushes nothing → the launch argv is byte-identical to today.
A dedicated test asserts this no-op. Behavior changes ONLY when an operator sets
`dynamicMcp.enabled:true` + a `keepWarm` trim.

## 2. Reversibility
Fully reversible. Removing the field/flag/method returns launch to its prior
behavior. The filtered config + state files live under `.instar/state/` and are
inert once the feature is disabled (the resolver enabled-gates FIRST, so a
disabled feature ignores any state file — verified by the C3 test).

## 3. State / data touched
Writes two best-effort files under `<projectDir>/.instar/state/` ONLY when enabled
+ trimming: a per-topic committed loaded-set (`mcp-loaded/<topic>.json`, atomic
temp+rename) and a unique filtered `--mcp-config` (`session-mcp-config/mcp-<topic>-<ts>.json`).
Never mutates `.mcp.json` (read-only; `filterMcpConfig` returns a new object).

## 4. Failure modes
Fail-safe to the FULL `.mcp.json` (`[]`) on EVERY error: unreadable/absent
`.mcp.json`, write failure, undefined topicId, any thrown error (outer try/catch).
A seed-write failure is swallowed and the launch still proceeds with the resolved
set. The worst case is "the full tool set", never "a session stranded without its
tools". State-file-unreadable-but-config-readable falls back to the LEAN baseline,
not full config (M6) — so a transient state error cannot relaunch every heavy
server warm and re-create the resource-panic condition.

## 5. Security / authority
None exercised here. This is launch-time config selection only — no restart of a
live session, no operator-approval flow (those land in the driver/routes commits
with the server-minted-nonce gate). No authority is taken; the agent cannot self-
authorize anything via this change.

## 6. Framework generality
The MCP `--mcp-config` / `--strict-mcp-config` mechanism is **Claude-Code
specific**. `buildSessionMcpFlags` returns `[]` for any framework other than
`claude-code` (explicit gate, tested), and `claudeCodeBuilder` is the only builder
that consumes `mcpFlags` — the **codex-cli**, **gemini-cli**, and **pi-cli**
builders ignore the option entirely. codex-cli configures MCP via `mcp_servers` in
its config.toml and gemini-cli differs again, so a per-framework MCP-trim is NOT
attempted for them here; this is a deliberate Claude-Code-scoped capability, not a
Claude-only assumption baked into a framework-general path. The `framework` is
resolved per-spawn (the topic's framework), so a codex session on a mixed-framework
agent is correctly excluded.

## 7. Tests
8 wiring tests (`session-manager-dynamic-mcp-flags.test.ts`) against a real temp
projectDir: dark ⇒ [] (no-op); non-claude-code ⇒ []; enabled+no-keepWarm ⇒ [];
enabled+lean ⇒ trimmed config + seeded committed state; committed state file wins;
un-committed state file ignored; unreadable `.mcp.json` ⇒ [] (fail-safe); undefined
topic ⇒ []. Plus the 26 + 10 pure-core tests. tsc clean across the project.

## Scope note
Ships behind the EXPLICIT `dynamicMcp.enabled` flag (not the dev-agent gate) on
purpose: baseline-trim must NOT go live before the on-demand load/offload driver
exists, or a trimmed dev session could be stranded without Playwright and no way to
load it. The flip to the dev-agent gate is the final step once the full path lands.
