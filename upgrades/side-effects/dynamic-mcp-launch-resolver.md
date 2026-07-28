# Side-effects review — dynamic-MCP launch-set resolver

**Change:** Add one pure function `resolveSessionMcpServers` (+ its input type) to
`src/core/dynamicMcpConfig.ts`, with 8 unit tests. It encodes the load-bearing
launch-set resolution ORDER from the converged spec (DYNAMIC-MCP-LIFECYCLE-SPEC.md),
folding convergence findings C3 (enabled-gate first ⇒ clean rollback) and M6
(state-unreadable ⇒ lean baseline, not full config). No wiring — pure, computes a
list only.

## 1. Blast radius
Zero at runtime. The function is not yet called by any live path; it is a pure
addition to an already-dark module. Behavior change lands only when the IO caller
(SessionManager.buildSessionMcpFlags) wires it in a later commit, behind a flag.

## 2. Reversibility
Fully reversible — removing the function + tests returns the module to the prior
committed state (1fbf13bbb). No persisted state, no migration, no config consumed.

## 3. State / data touched
None. Reads nothing, writes nothing. Returns a fresh array or null.

## 4. Failure modes
None reachable here (no IO). The function is total over its typed inputs. Its
DESIGN intent is fail-safe: the caller passes `stateFileUnreadable:true` on a read
error and the resolver returns the lean baseline (M6), never full config; and the
enabled-gate returns null (full) first so a disabled feature is a clean no-op (C3).

## 5. Security / authority
None. No authority exercised; the live-restart authority + the operator-approval
nonce flow land in the driver/routes commits with their own review.

## 6. Framework generality
The resolver itself is framework-data-driven: it takes `framework` as input and
returns null (full .mcp.json) for any non-`claude-code` framework, because the MCP
`--mcp-config` mechanism is Claude-Code-specific (codex-cli uses `mcp_servers` in
config.toml; gemini differs). The eventual spawn caller will resolve THIS topic's
framework and pass it in. No Claude-only assumption is baked in beyond that
explicit, tested gate.

## 7. Tests
8 new unit tests (26 total in the file): disabled-with-committed-state ⇒ null (C3);
non-claude-code ⇒ null; committed state wins; empty committed ⇒ []; unreadable ⇒
lean baseline (M6); unreadable + no baseline ⇒ null; baseline present ⇒ baseline;
no state + no baseline ⇒ null. tsc clean.
