# Side-effects review — dynamic-MCP load/offload driver

**Change:** New `src/core/DynamicMcpManager.ts` — the load/offload orchestration
for the dynamic-MCP lifecycle. All IO is INJECTED (state write, restart, pid
capture/reap, authorization, mid-tool-use probe); the class touches no
fs/process/network directly. 16 unit tests via fakes.

## 1. Blast radius
Zero at runtime. The class has NO importer yet (verified by grep) — nothing
instantiates it. It becomes live only when the routes/sweep wire it with real
deps (a later commit, behind the dark flag).

## 2. Reversibility
Fully reversible — deleting the file + tests removes it. No persisted state, no
migration, no config consumed.

## 3. State / data touched
None directly. The class CALLS injected `writeLoadedSet` / `reapPids` / etc., but
in this commit those are only ever the test fakes.

## 4. Failure modes
The orchestration is designed fail-safe: a non-`ok` restart rolls the committed
state back to the prior set (no phantom unapproved change); an offload whose
restart fails does NOT reap the captured pids (the old session is still alive); a
mid-tool-use `true` OR `null` aborts an offload (fail-closed); audit is best-effort
(a throwing audit sink never breaks a change). Authorization fails closed: an
unverified request returns needs-approval, never proceeds.

## 5. Security / authority
This is the authority-bearing core, so the gate is built to the "Agent Proposes,
Operator Approves" + Know-Your-Principal standards: a change proceeds ONLY when
the topic is LIVE-preapproved (re-checked via the injected `isPreapproved`, not
trusted from the caller) OR an operator-supplied single-use nonce is consumed
successfully. An `agent`-actor request that is not preapproved can NEVER proceed —
it returns needs-approval with a server-minted nonce. The approval prompt text is
server-authored (a fixed template), never agent free-text. No authority is
exercised in this commit (nothing wires it live).

## 6. Framework generality
Not applicable here — the manager is framework-neutral orchestration over injected
deps. The Claude-Code-specific surface (the actual `--mcp-config` restart) lives in
the deps' implementations, which the wiring commit will scope to claude-code (the
restart dep returns `unsupported-unbound`/`not_telegram_bound` for sessions the
restart mechanism doesn't support).

## 7. Tests
16 unit tests (`dynamic-mcp-manager.test.ts`): no-op short-circuits (already-loaded
/ not-loaded / unknown-server, no restart); the auth gate both sides incl. valid vs
invalid nonce; two-phase write-then-commit + rollback on a failed restart;
not_telegram_bound ⇒ unsupported-unbound; offload capture→restart→reap ordering;
no-reap on a failed offload restart; mid-tool-use true/null abort; load skips the
mid-tool-use check; per-topic serialization (no two restarts in flight for one
topic). tsc clean.
