# Side-effects review — dynamic-MCP pure cores

**Change:** Two pure, dark-by-default decision modules for the on-demand MCP
lifecycle: `src/core/dynamicMcpConfig.ts` (baseline trim + load/offload mutation)
and `src/monitoring/mcpIdleLiveOffload.ts` (idle-offload eligibility). 28 unit
tests. No wiring — these compute answers only; nothing spawns, kills, or writes.

## 1. Blast radius
Zero at runtime. Neither module is imported by any live code path in this commit;
they are pure functions with no side effects. The eventual wiring (next commit)
is where behavior changes, and it ships behind a disabled flag.

## 2. Reversibility
Fully reversible — deleting the two files and their tests returns the tree to
its prior state. Nothing persisted, no migrations, no config consumed yet.

## 3. State / data touched
None. No files written, no DB, no network. `mutateLoadedServers` and
`resolveBaselineServers` return fresh arrays; `filterMcpConfig` returns a new
object and never mutates its input (explicitly tested).

## 4. Failure modes
Fail-closed by construction. `decideIdleLiveOffload` keeps the server on ANY
uncertainty: feature off, owner not live, light signature, keep-warm, mid-tool-use
true OR unknown (null), or idle clock not yet crossed. `mutateLoadedServers`
rejects loading an undefined server and no-ops a redundant load/offload. There is
no path that can drop a tool out from under a session in this commit (no actuation).

## 5. Security / authority
None exercised here. The actuation layer (restart a live session) carries real
authority and lands in the wiring commit with the full Tier-2 spec ceremony —
including the now-decided authorization model: an autonomous/preapproved session
loads + restarts autonomously; a non-preapproved session must ASK the operator
("ready for a quick restart?") before acting. That gate is NOT in this commit.

## 6. Framework generality
Not applicable to these two pure modules (they touch no framework launch/inject
surface). NOTE for the wiring commit: injecting the lean baseline at spawn WILL
touch the Claude-code launch path, and MCP config is a Claude-Code-specific
mechanism (`--mcp-config`/`--strict-mcp-config`); codex-cli and gemini-cli handle
MCP differently. The wiring will scope the baseline-trim + restart to the
claude-code framework branch and state that reasoning in its own artifact.

## 7. Tests
28 unit tests covering both sides of every decision boundary (baseline
on/off/trim, load known/unknown/redundant, offload present/absent/to-empty,
idle-offload each gate both ways, fail-closed on unknown mid-tool-use). tsc clean.

## Decision context
Supersedes the static per-topic profile model (#1292, held as draft) per Justin's
2026-06-27 correction: MCP needs are not knowable at launch and must be mutable
mid-session via restart. Design now fully decided: genuinely-lean baseline +
load-on-demand gated by preapproval (autonomous = preapproved; else ask).
