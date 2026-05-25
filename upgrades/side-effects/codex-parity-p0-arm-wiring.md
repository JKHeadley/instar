# Side-Effects Review: P0 arming wiring (init + migrate, B2-atomic)

## Change
Wire `armCodexHooks` into the two paths that write the Codex hooks.json, so registration is
immediately followed by arming (the guards actually become live):
- `PostUpdateMigrator` (update path): after `installCodexHooks`, arm — atomic with the rewrite
  (the rewrite invalidates trust; re-arm now). Opt-out via `config.codex.autoArmHooks === false`.
  Gated on `detectCodexPath()` (skip + log if no binary). Fail-soft: failures → result.errors,
  never aborts migration. `partial` outcome is logged as a visible error.
- `init.ts` (new agent): after `installCodexHooks`, best-effort arm (fail-soft — a brand-new agent
  may not be Codex-logged-in yet; the first update's migration re-arms).

## Why (B2 — the convergence review's blocking item)
Rewriting hooks.json changes the hashes → Codex untrusts the guards until re-armed. Shipping the
rewrite WITHOUT re-arming would leave existing Codex agents LESS protected than before (dark guards
on an autonomous agent with no human to click trust). Arming in the same step closes that window.
Idempotent: armCodexHooks skips the spawn when hooks are already trusted (unchanged), so this only
drives Codex when the hook set actually changed.

## Scope / blast radius
- Migration/init now MAY spawn a one-time interactive codex (detached tmux, ~≤50s, NO bypass flags)
  to drive Codex's trust prompt — ONLY when the hook set changed (idempotent skip otherwise) and
  only for codex-cli agents with a resolvable binary. Detached → does not block the init wizard's
  foreground. Fail-soft everywhere. Default ON; `config.codex.autoArmHooks:false` opts out.
- No Claude-agent impact (codex-cli gated). No migration of existing data. Runtime code (ships with dist).

## Signal vs Authority / Over-block
- Arms existing safety hooks (makes them run); no new gate authority. Per-agent (path-keyed trust);
  operator's personal Codex untouched (project-scoped hooks).

## Rollback
- Revert the two wiring blocks; the armCodexHooks/codexHookTrust modules remain (unused).

## Tests
- 37 green across migration-parity + installCodexHooks + codexHookArm + codexHookTrust (arming
  skips in CI — no codex binary — so no regression). The arming itself is LIVE-PROVEN end-to-end
  (see codex-parity-p0-arm-realpath-liveproof.md): fresh agent → armed (no clicks) → rm -rf blocked.

## Publish
- Feature branch `echo/codex-parity-audit`. P0 ships atomic with P1.
