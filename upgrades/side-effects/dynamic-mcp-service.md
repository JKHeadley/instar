# Side-effects review — dynamic-MCP composition service

**Change:** New `src/core/DynamicMcpService.ts` — the composition root that
assembles DynamicMcpManager + McpLoadedSetStore + McpApprovalNonceStore and wires
them to INJECTED host primitives (restart, preapproval, pid capture/reap,
mid-tool-use). Exposes getSessionState / requestLoad / requestOffload. 7 unit tests.

## 1. Blast radius
Zero at runtime. No importer yet — AgentServer wires it with real primitives in the
final commit (behind the dark flag).

## 2. Reversibility
Fully reversible — delete the file + tests. No migration; consumes the dynamicMcp
config block only when instantiated (which nothing does yet).

## 3. State / data touched
Indirectly via McpLoadedSetStore (writes `.instar/state/mcp-loaded/<topic>.json`)
and reads `.mcp.json` — but ONLY when a caller invokes requestLoad/requestOffload,
which only the tests do in this commit. Never mutates `.mcp.json`.

## 4. Failure modes
Inherits the manager's fail-safety (verified-auth, two-phase rollback, capture-then-
reap, mid-tool-use abort). `.mcp.json` unreadable ⇒ [] names ⇒ a load is
unknown-server no-op; currentServers falls back baseline→full safely.

## 5. Security / authority
The authority gate lives in the injected `isPreapproved` + the nonce store: a
non-preapproved request returns needs-approval with a server-minted nonce and
performs no restart. The service never trusts a caller-supplied approval; only a
consumed nonce or a live preapproval proceeds.

## 6. Framework generality
Framework-neutral composition. The Claude-Code-specific surface lives in the
primitives AgentServer injects (the restart maps SessionRefresh, which returns
not_telegram_bound ⇒ unsupported-unbound for sessions it can't restart).

## 7. Tests
7 unit tests vs a real temp projectDir: lean-baseline state read; full load+restart+
commit; not-preapproved ⇒ needs-approval then nonce authorizes; forged nonce
rejected; offload drops+reaps; offload aborts on unknown mid-tool-use; failed
restart leaves committed set unchanged (rollback). tsc clean.
