# Side-effects review — fresh-session stop-gate shadow wiring

**Scope**: Complete the conservative first rollout for the fresh-session stop-gate: wire the existing server authority/database, install a Stop-hook router, and default to observe-only shadow mode when the gate is healthy.

**Files touched**:
- `src/commands/server.ts` — constructs `StopGateDb` and `UnjustifiedStopGate`, persists mode state, passes both into `AgentServer`.
- `src/server/stopGate.ts` — persists mode flips to `server-data/stop-gate-mode.json`.
- `src/server/routes.ts` — records SessionStart rows in `StopGateDb` when hook events arrive.
- `src/core/PostUpdateMigrator.ts` — installs `stop-gate-router.js` and patches `.claude/settings.json` Stop hooks.
- `src/commands/init.ts` and `src/templates/hooks/settings-template.json` — include the router on fresh installs.
- `src/core/installCodexHooks.ts` — mirrors the Stop router into Codex hook config.
- Focused tests cover route mode persistence, hook behavior, Codex registration, and update migration.

**Under-block**: Intentional for this PR. Default mode is `shadow` only when the authority and SQLite log initialize successfully; otherwise the gate is `off`. In shadow mode the hook submits evaluations but always lets the agent exit. Enforcement is reserved for a later explicit operator flip.

**Over-block**: Minimal. The router only emits `{decision:"block"}` when the server is already in `enforce` mode and the server authority returns `continue` with a reminder. All network errors, malformed hook payloads, missing config, hot-path failures, compaction-in-flight, kill-switch, and degraded initialization paths fail open.

**Signal vs authority**: Compliant. The hook collects evidence metadata and simple signals, but never decides whether a Stop is unjustified. The server-side `UnjustifiedStopGate` remains the sole authority for `continue`; the hook is a transport/router.

**External surfaces**:
- New installed hook file: `.instar/hooks/instar/stop-gate-router.js`.
- Existing routes become live for real Stop events: `GET /internal/stop-gate/hot-path` and `POST /internal/stop-gate/evaluate`.
- New persisted mode file: `server-data/stop-gate-mode.json`.
- Existing SQLite event log: `server-data/stop-gate.db`.

**Migration parity**:
- Post-update migration writes the router and patches existing Claude settings.
- Fresh `instar init` installs the router template.
- Codex hook installer places the router first in the Stop chain before the existing review trio.

**Rollback cost**: Revert this change set. Existing `stop-gate-mode.json` and `stop-gate.db` files can remain on disk; without the router/server wiring they are inert. Emergency runtime rollback without code revert: `instar gate mode off` or set the kill-switch.

**Tests**:
- `npm test -- --run tests/unit/routes-stopGate.test.ts tests/unit/stop-gate-router-hook.test.ts tests/unit/installCodexHooks.test.ts tests/unit/PostUpdateMigrator-codexHooks.test.ts`
- `npx tsc --noEmit`
