# Side-Effects — pi-cli load-path fix: loadConfig must carry `sessions.frameworkDefaultModels`

**Tier:** 1 (small, low-risk, single-field config-loader pass-through + tests)
**Branch:** echo/fix-pi-framework-default-models (off JKHeadley/main @ v1.3.667)
**Files:** `src/core/Config.ts`, `tests/unit/Config.test.ts`

## What changed
`loadConfig` (src/core/Config.ts) builds the `sessions` block from an explicit
field list. It copied `componentFrameworks` (fixed 2026-06-06) but **never copied
`sessions.frameworkDefaultModels`** from the config file. This change adds the
identical pass-through for `frameworkDefaultModels`, guarded by the same
`typeof === 'object'` check so an absent field stays absent (no phantom field).

## Why (root cause)
`server.ts` builds the pi-cli intelligence provider from
`config.sessions.frameworkDefaultModels['pi-cli']` (pi's REQUIRED model pattern;
the factory degrades pi to `null` without it). Because the loader dropped the
field, the pattern was **always `undefined` at boot** → the factory degraded
pi-cli to null and logged `framework 'pi-cli' unavailable (binary missing / not
built)` → **pi-cli was silently UNAVAILABLE on every deployed agent**, despite a
valid `pi` binary (0.78.1) and a correct config value. Confirmed empirically:
`loadConfig()` over a config with `sessions.frameworkDefaultModels` returned it
`undefined` before the fix and the correct map after.

## Blast radius
- **Surface:** one additive field on the loaded `SessionManagerConfig.sessions`
  (the type already declares `frameworkDefaultModels?`). No signature changes.
- **Behavior delta:** agents that set `sessions.frameworkDefaultModels` in
  `.instar/config.json` now have it honored at boot. Agents that DON'T set it are
  byte-identical (the field stays `undefined` — covered by the "omits when absent"
  test). The pi-cli provider only builds when BOTH a binary is detected AND a
  model pattern is present, so this cannot accidentally activate pi for an agent
  without the binary.
- **Who is affected:** any agent that wants pi-cli (or any per-framework default
  model) — previously impossible to enable via the file; now works.

## Risk / failure modes
- Low. The field is optional and validated (`typeof === 'object'`). A malformed
  value can at worst be passed to the factory, which already guards each model
  value and degrades to the default framework with a report.
- No migration needed (additive read of an existing-but-dropped file field;
  default-absent behavior preserved).

## Rollback
Revert the single Config.ts hunk. The deployed live hotfix on the dev agent has a
backup at `.instar/shadow-install/node_modules/instar/dist/core/Config.js.pre-pifix-bak`.

## Verification
- New unit tests: "carries sessions.frameworkDefaultModels …" and "omits …" —
  both green (Config.test.ts: 9/9 pass).
- Live: deployed to the running dev agent, restarted, `/intelligence/routing`
  shows `pi-cli available:true`, the tone gate routed to pi-cli served a real
  verdict, and a Telegram reply went through first-try at ~6s.

## Tests
- `tests/unit/Config.test.ts` — load-path wiring (carries) + no-phantom-field (omits).
