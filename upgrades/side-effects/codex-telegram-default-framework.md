# Side-effects review — Telegram default-framework fix (codex agents)

**Scope**: Follow-on to framework-spawn-portability (v1.2.31). The
original fix corrected the fresh-spawn path
(`spawnInteractiveSession`'s internal framework resolution) but missed
the Telegram message path (`spawnSessionForTopic` →
`resolveTopicFramework` → `_defaultFramework`). `_defaultFramework` was
sourced from `frameworkFromEnv()` only, so a codex-cli-only agent
without the `INSTAR_FRAMEWORK` env var defaulted to claude-code and
spawned Claude on every Telegram message — and because the Telegram
path passes its framework as the per-call `options.framework`
(highest precedence), it overrode the correct `config.framework`.
Governed by the existing converged + approved spec
`specs/dev-infrastructure/framework-spawn-portability.md`.

**Files touched**:
- `src/commands/server.ts` — one line in `startServer`:
  `const framework = frameworkFromEnv() ?? 'claude-code';`
  →
  `const framework = config.sessions?.framework ?? frameworkFromEnv() ?? 'claude-code';`
  plus an explanatory comment. `config.sessions.framework` is the
  resolved runtime framework (`resolveConfiguredFramework` output from
  `Config.load`, line 635), so the Telegram default now matches the
  fresh-spawn path.
- `tests/unit/framework-spawn-portability.test.ts` — 2 new source-grep
  assertions (derivation reads `config.sessions?.framework`; the
  env-only derivation is gone).

**Under-block**: None. The change makes a previously-ignored config
field authoritative for the Telegram default. There is no path where a
framework that *should* spawn is now suppressed: per-topic overrides
(`_topicFrameworksStore` / `_topicFrameworks`) still win over the
default (they're checked first in `resolveTopicFramework`), and the
`INSTAR_FRAMEWORK` env still applies as a fallback when
`config.sessions.framework` is somehow unset.

**Over-block**: None. A claude-code agent (config.sessions.framework =
'claude-code') still resolves to claude-code. A codex-cli agent now
correctly resolves to codex-cli instead of silently falling back to
claude-code. The only behavior change is the bug being fixed.

**Level-of-abstraction fit**: The Telegram default now reads the same
single resolved value (`config.sessions.framework`) that the
SessionManager's internal resolution reads. One source of truth, both
spawn paths. `resolveTopicFramework`'s precedence (per-topic store >
per-topic config map > default) is unchanged — only the *default's*
source is corrected.

**Signal vs authority**: Compliant. `config.sessions.framework`,
`INSTAR_FRAMEWORK`, and per-topic overrides are all SIGNALS;
`resolveConfiguredFramework` (in Config.load) is the single AUTHORITY
that resolves the agent-level framework, and `resolveTopicFramework`
layers per-topic overrides on top. No new authority introduced.

**Interactions**:
- `resolveTopicFramework` callers (the Telegram spawn path) now get the
  correct default. The per-topic `/route` override path is unaffected
  (it sets `_topicFrameworksStore`, checked before the default).
- `spawnSessionForTopic` passes `framework` as `options.framework` to
  `spawnInteractiveSession`. With the fix, that value is now correct
  for codex-cli agents, so the per-call override and the internal
  `config.framework` resolution agree (no conflict).
- `resolvedFramework` (used a few lines later to pick the
  IntelligenceProvider for relationships/shared intelligence) now also
  reflects the configured framework — correct: a codex-cli agent's
  shared intelligence provider should match its framework.

**External surfaces**: None. No new API endpoint, no new config field
(the `INSTAR_FRAMEWORK` env and `enabledFrameworks` config already
existed), no CLI change.

**Migration parity**: No agent-installed file change. The fix is a
server-startup derivation; deployed codex-cli agents get correct
behavior on their next update + clean restart. IMPORTANT operational
note (documented in NEXT.md): an agent running an older server process
keeps the stale `_defaultFramework` in memory until restarted, even
after its files update. This is the version-skew pattern — "updated"
≠ "running the update". The codey incident that surfaced this bug was
partly this: the fix-bearing files were present but a long-running
process still served the old default.

**Rollback cost**: Trivial. Revert one line in server.ts + the 2 test
assertions.

**Tests**:
- 12/12 `framework-spawn-portability.test.ts` (10 existing + 2 new).
- `tsc --noEmit` clean. `npm run lint` clean.
- Empirical end-to-end confirmation (live codex-cli agent spawns
  `codex --model gpt-5.3-codex` on a Telegram message, not `claude`)
  is performed during rollout per the bug-fix evidence bar.

**Decision-point inventory**:
1. Derive `_defaultFramework` from `config.sessions.framework` (vs.
   adding yet another env read or a new config field) — reuses the
   single resolved value the rest of the system already trusts. No new
   knob.
2. Keep `frameworkFromEnv()` + `'claude-code'` as fallbacks (vs.
   removing them) — defense-in-depth: if `config.sessions.framework`
   is ever unset (older Config.load, or a hand-edited config), the env
   var and historical default still apply. The fix only re-orders
   precedence to put the resolved config value first.
3. Regression test via source-grep (vs. spinning up a full server) —
   `_defaultFramework` is module-private state set inside the large
   `startServer`; a source-grep assertion that the derivation reads
   `config.sessions?.framework` is the proportionate guard, matching
   the existing framework-spawn-portability spawn-path assertions.
