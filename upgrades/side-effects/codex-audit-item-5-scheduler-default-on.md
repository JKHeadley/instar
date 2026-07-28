# Side-effects review — Codex-instar audit Item 5: scheduler default-on

**Scope:** Scheduler now defaults to `enabled: true` in two places:

1. `src/core/Config.ts:653` — the runtime fallback when `fileConfig.scheduler?.enabled` is undefined now returns `true` instead of `false`.
2. `src/config/ConfigDefaults.ts` — `SHARED_DEFAULTS.scheduler.enabled: true` is added to the migration defaults registry. Via the existing `applyDefaults()` semantics, this BACKFILLS missing fields into existing agents' configs but **never overrides** an explicit operator-set value (including explicit `false`).

Together: new agents get scheduler-on by scaffold AND by runtime fallback. Existing agents with a scheduler block missing the `enabled` field get backfilled to true on next `instar update`. Agents that explicitly set `enabled: false` keep their setting.

Discovered by codey during the 2026-05-22 Codex-instar shortcomings audit (blocker #5): codey's `.instar/config.json` had `scheduler.enabled: false` and `/status.scheduler` was null, losing autonomy-continuity tasks (org-intent drift audits, threadline sync, post-update self-healing).

**Files touched:**
- `src/core/Config.ts` — change `?? false` to `?? true` on the scheduler `enabled` field of the resolved runtime config.
- `src/config/ConfigDefaults.ts` — add `scheduler: { enabled: true }` to `SHARED_DEFAULTS`.
- `tests/unit/ConfigDefaults.test.ts` — 3 new cases: (1) new agents default-enable scheduler for both managed-project and standalone, (2) existing scheduler blocks lacking `enabled` get backfilled, (3) explicit `enabled: false` is preserved.

**Under-block:** None. The change makes the runtime safer (autonomy continuity restored) and is purely additive at the migration layer.

**Over-block:** Agents that genuinely intended scheduler-off but never wrote `enabled: false` explicitly will get scheduler-on after the next update. This is a deliberate, narrow correction — instar's autonomy-continuity primitives assume the scheduler runs, so absence of an explicit choice should resolve to "on". Agents that intentionally disabled scheduler must have `enabled: false` literally in their config to preserve the setting (which is the existing migration contract: `applyDefaults` never overrides). For the audit follow-through I also flipped codey's explicit `false` to `true` directly, per the audit recommendation; that's an operator-on-behalf action, not a code-level override.

**Level-of-abstraction fit:** Two parallel changes at two layers:
- Runtime layer (Config.ts): handles agents whose config has no `scheduler.enabled` field at all (e.g., test fixtures, stripped-down configs). Single-line change in the same expression that already provides defaults for the other scheduler fields.
- Migration layer (ConfigDefaults.ts): handles agents whose config is missing the field and which want the field PERSISTED to disk on next update (so subsequent reads are deterministic).

The two layers complement each other and don't duplicate behavior: migration writes the field if missing, runtime falls back if for some reason migration didn't run yet.

**Signal vs authority compliance:** `config.scheduler.enabled` is a SIGNAL (operator-set knob); the JobScheduler's startup decision (line 2730/2798 of server.ts) is the AUTHORITY. The fix only changes what the SIGNAL resolves to when unset — no new authority.

**Interactions:**
- HealthChecker (`scheduler.enabled` check) and `CapabilityIndex.ts:114` will report scheduler:on for agents previously silent.
- `instar status` CLI now reports "Scheduler: Enabled: yes" for those agents.
- The 27 default jobs scaffolded into codey now actually run; that's the intended behavior. Quota-aware throttling, supervision-tier gating, and per-job `enabled: true/false` flags continue to apply.
- No interaction with the spawn manager (Item 2) or with relay-send (Item 1).

**External surfaces:** None. No new API endpoint, no new CLI flag.

**Migration parity:** Yes — ConfigDefaults' `applyDefaults` is already wired into PostUpdateMigrator (line 3267 of PostUpdateMigrator.ts). Existing agents pick up the backfill on next update. No new migration entry needed — the registry-based pattern does the right thing.

**Rollback cost:** Trivial. Revert the `?? false` → `?? true` change in Config.ts, remove the `scheduler` block from `SHARED_DEFAULTS`, delete the 3 new test cases.

**Tests:**
- `tests/unit/ConfigDefaults.test.ts`: 19/19 pass (16 existing + 3 new).
- `tsc --noEmit`: clean.
- Empirical confirmation on codey codex-cli agent: codey's `/status.scheduler` went from null to `{ running: true, jobCount: 27, enabledJobs: 27, activeJobSessions: 1 }` after the migration ran + the explicit `false` was flipped + server restarted. Documented in `instar-codey/echo_chat.md` at 2026-05-23 07:45 UTC.

**Decision-point inventory:**
1. **Auto-flip explicit false vs preserve.** The existing `applyDefaults` contract is "only add missing keys, never override". Auto-flipping `false → true` would violate that contract and could trample legitimate operator opt-outs. Decision: preserve. Operators who want scheduler-off keep it. For codey, the audit explicitly asked for the flip, so I did it as a one-off operator-on-behalf action (file edit, not code change), separate from the framework fix.
2. **Two layers (runtime + migration) vs one.** Runtime alone would fix new agents at runtime but never persist the value to disk; migration alone would fix existing agents on update but not test fixtures or one-off configs. Both layers handle distinct cases without duplication.
3. **Same default for managed-project and standalone.** SHARED_DEFAULTS rather than TYPE_OVERRIDES — the scheduler is equally useful for both agent types. Avoids a needless fork.
