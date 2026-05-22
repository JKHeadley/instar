# Side-effects review — framework-spawn portability (codex agents spawn Codex)

**Scope**: A Codex-only agent ("codey") spawned a Claude Code session when
messaged on Telegram. Two compounding bugs: (1) `spawnInteractiveSession`
hardcoded `'claude-code'` and never read config/env; (2) the runtime's
`resolveConfiguredFramework` read `sessions.framework` + `INSTAR_FRAMEWORK`,
neither of which the wizard sets — the wizard persists `enabledFrameworks`.
So the runtime always resolved claude-code for wizard-installed Codex agents.

**Files touched**:
- `src/core/types.ts` — add optional `framework?: 'claude-code' | 'codex-cli'`
  to `SessionManagerConfig` (the resolved runtime framework).
- `src/core/Config.ts` — `resolveConfiguredFramework` takes a third arg
  `enabledFrameworks`; new precedence configValue → env → enabledFrameworks[0]
  → 'claude-code'; explicit `claude`/`claude-code` env branch added; `loadConfig`
  passes `fileConfig.enabledFrameworks` and stores the result on
  `sessions.framework` (the SessionManagerConfig field).
- `src/core/SessionManager.ts` — `spawnInteractiveSession` replaces the
  hardcoded default with `resolveInteractiveFramework({ perCall, configFramework:
  this.config.framework, envFramework })`; `spawnSession` changes
  `configFramework: undefined` → `this.config.framework`.
- `tests/unit/framework-spawn-portability.test.ts` — 10 tests: precedence of
  resolveConfiguredFramework (incl. enabledFrameworks fallback + explicit-claude
  env), source-grep that both spawn paths read config.framework, and Config.load
  wiring (enabledFrameworks → config.framework).

**Under-block**: None. The fix makes a previously-ignored config field
authoritative. There is no path where a framework that *should* spawn is now
suppressed — per-call override and explicit config/env all still win.

**Over-block**: None. A codex-cli agent will now correctly REFUSE to silently
fall back to Claude. If a caller genuinely wants a one-off Claude session on a
Codex agent, the per-call `options.framework` override still does that — it sits
at the top of the precedence chain. So the "block" here is exactly the intended
behavior (honor the install choice), with a documented escape hatch.

**Level-of-abstraction fit**: Framework resolution stays in one place
(`resolveConfiguredFramework` / `resolveInteractiveFramework`). The spawn paths
do not re-implement precedence; they pass their three inputs and take the
answer. `enabledFrameworks` (install choice) is reduced to a single resolved
`config.framework` at load time, so SessionManager never has to know about the
array shape. Correct layering: array-of-enabled is an install concept; the
runtime sees one resolved framework.

**Signal vs authority**: Compliant. `enabledFrameworks`, env, and per-call
options are all SIGNALS fed into the resolver. The resolver
(`resolveConfiguredFramework`) is the single AUTHORITY that picks one framework.
No spawn-path makes its own framework decision anymore — both defer to the
resolved value.

**Interactions**:
- `spawnSession` (scheduled jobs) and `spawnInteractiveSession` (messages) now
  resolve identically. Before, only spawnSession read env; the interactive path
  was the one that hit the bug. They are now symmetric.
- `frameworkBinaryPaths[framework] ?? claudePath` fallback is unchanged — if a
  codex-cli framework has no binary path mapped, it still falls back to
  claudePath. That fallback is a *binary-path* concern, separate from framework
  *selection*; out of scope here. For correctly-installed Codex agents the codex
  binary path is populated by `detectCodexPath()` in loadConfig.
- No change to `checkFrameworkPrerequisite` or the parity sentinel — they read
  `enabledFrameworks` directly and are unaffected by the new derived field.

**External surfaces**: None. No new API endpoint, no new config field the user
writes (the new `framework` is derived, not user-authored), no CLI change. The
`enabledFrameworks` field already existed and was already written by the wizard.

**Migration / existing agents**: No migration needed. The fix is a config-LOAD
derivation. Deployed Codex agents already have `enabledFrameworks: ['codex-cli']`
on disk (their install wrote it). The moment they update and the server reloads
config, `config.framework` resolves to codex-cli and both spawn paths honor it.
Verified by the Config.load wiring test.

**Rollback cost**: Trivial. Revert three source files + the test. The derived
field is optional; nothing persists it to disk, so a revert leaves no orphaned
state.

**Tests**: 10/10 new tests pass; 11/11 existing `frameworkPrerequisite.test.ts`
pass (no regression in the shared resolver). `npx tsc --noEmit` clean.
`npm run lint` clean.

**Decision-point inventory**:
1. Derive `config.framework` at load (vs. teach every spawn path to read
   `enabledFrameworks` itself) — single resolution point, single authority,
   keeps SessionManager ignorant of the array shape. Chosen.
2. `enabledFrameworks[0]` slots BELOW env (vs. above) — an explicit
   `INSTAR_FRAMEWORK` env at boot is a deliberate per-boot override and should
   beat the persisted install default. Matches the existing env-over-default
   intent.
3. No init-time write of `sessions.framework` (vs. backfilling it) — the
   load-time derivation already fixes existing agents with zero migration; a
   redundant on-disk write is deferred as unnecessary (noted out-of-scope in the
   spec).
