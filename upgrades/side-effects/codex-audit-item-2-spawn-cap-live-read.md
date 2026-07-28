# Side-effects review — Codex-instar audit Item 2: SpawnRequestManager live cap read

**Scope:** `SpawnRequestManager` now reads its session cap via an optional `getMaxSessions: () => number` live accessor on every admission check, instead of only consulting the constructor-time `maxSessions` snapshot. The denial message in `Session limit reached (${activeSessions.length}/${liveMaxSessions})` reports the live value too.

The construction site in `src/commands/server.ts` passes a live accessor that reads `config.sessions?.maxSessions ?? config.maxSessions ?? 5` — canonical key first, legacy top-level key as fallback, hardcoded default last. This also pre-resolves the legacy-vs-canonical key ambiguity flagged in audit Item 10 (full migration of the legacy key still pending).

Discovered by codey during the 2026-05-22 Codex-instar shortcomings audit (blocker #2). codey observed the split-brain on echo's live state: `/status.sessions.max` showed 30 while threadline spawn-denial payloads still reported `Session limit reached (15/10)`, indicating the manager held a stale constructor snapshot while routes read the current config.

**Files touched:**
- `src/messaging/SpawnRequestManager.ts` — added `getMaxSessions?: () => number` to `SpawnRequestManagerConfig`. The session-limit check at line 519 reads `this.#config.getMaxSessions?.() ?? this.#config.maxSessions`. The denial message uses the live value.
- `src/commands/server.ts` — passes `getMaxSessions: () => config.sessions?.maxSessions ?? (config as { maxSessions?: number }).maxSessions ?? 5` alongside the existing constructor `maxSessions` for back-compat.
- `tests/unit/spawn-request-manager.test.ts` — 3 new tests: (1) live accessor overrides stale constructor value, (2) constructor fallback when accessor not provided, (3) denial reason reports live cap, not stale.

**Under-block:** None. If the live accessor returns the same value as the constructor (no operator-driven change), behavior is identical. If it returns a higher value (operator raised the cap), the manager now permits more sessions — exactly the intended fix. If it returns a lower value (cap lowered post-startup), the manager now denies more aggressively — also intended.

**Over-block:** None. The cap-override policy for `'critical'` and `'high'` priority requests is unchanged; only the cap source moved. A caller who could spawn under the old code (in-cap) can still spawn under the new code (in-cap, with possibly a higher live cap).

**Level-of-abstraction fit:** The live accessor sits at the same level as the existing `getActiveSessions: () => Session[]` callback — both are read-side closures the consumer provides so the manager can pull current state on demand. No new layer introduced. The legacy `maxSessions` field remains as a back-compat fallback, so callers that haven't wired the accessor (tests, embedded uses) keep working.

**Signal vs authority compliance:** The live `config.sessions?.maxSessions` value is a SIGNAL (operator-set knob). The cap-enforcement is the AUTHORITY (`SpawnRequestManager.evaluate`). The fix keeps that separation — the manager is now structurally able to honor a fresh signal without rebuild.

**Interactions:**
- `/status` route (`ctx.config.sessions?.maxSessions ?? 10`), `status` CLI (`config.sessions.maxSessions`), `HealthChecker.ts` (`this.config.sessions.maxSessions`), and `SpawnRequestManager` all now read from the same place — eliminates the split-brain.
- The legacy fallback `(config as { maxSessions?: number }).maxSessions` accommodates older configs that still have only the top-level key. A full canonicalization migration (audit Item 10) will deprecate this branch.
- No interaction with cooldown / penalty / drain-loop logic — the cap check is at the same point in `evaluate` as before.

**External surfaces:** None. No new HTTP route, no new config knob, no new CLI flag. The `getMaxSessions` field is an internal manager-config callback.

**Migration parity:** No agent-installed file change. Existing agents pick up the fix on next `instar update` + server restart. Behavior change is purely server-side. No `.instar/config.json` migration is required for the FIX itself (the fallback chain reads whichever key the agent already has). The Item 10 canonicalization migration will be a separate idempotent entry in `PostUpdateMigrator`.

**Rollback cost:** Trivial. Revert the field addition + the two-line check in `SpawnRequestManager.ts` and the construction-site closure in `server.ts`. Delete the 3 new test cases.

**Tests:**
- `tests/unit/spawn-request-manager.test.ts`: 76/76 pass (existing 73 + 3 new).
- `tsc --noEmit`: clean.
- Empirical confirmation on codey codex-cli agent: SpawnRequestManager.js in the shadow-install contains `liveMaxSessions`; `/status.sessions.max` reads correctly from `config.sessions.maxSessions`. Full split-brain repro on echo (operator raises the cap, manager denial reflects the new cap) requires either a config-reload mechanism (not yet implemented) or a fresh server restart. The structural fix is in place either way.

**Decision-point inventory:**
1. **Live accessor vs. config-reload event bus.** A pull model (accessor) lets the manager read on demand without subscribing to events. Cheap (one function call per admission), no listener-leak surface, and works regardless of whether the consumer has a reload mechanism. An event bus would be overkill for a single read-side knob.
2. **Keep `maxSessions: number` for back-compat vs. require the accessor.** Keeping it makes existing tests and any external callers continue working unchanged. The accessor is opt-in; absent it, the manager behaves exactly as before.
3. **Pre-resolve the legacy `config.maxSessions` at the construction site vs. only inside the manager.** Doing it at construction puts the legacy-key knowledge in `server.ts` (the boundary layer) rather than inside the manager (which doesn't know about config shape). This makes Item 10 canonicalization a single-file change later.
