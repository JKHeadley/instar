# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

New per-agent, opt-in config flag **`updates.restartImmediately`** (default
**false**). When true, that agent's update restarts are **never deferred** — not
for active sessions, not for the restart window — so it always rolls onto the
latest version as soon as it is downloaded.

This is intended for the instar developer's own agent (always-current is
required when you build and dogfood the fleet). It is **off by default**, so the
fleet's existing session-aware + window-aware restart deferral is unchanged.

## What to Tell Your User

Nothing for almost everyone — this is off by default and changes nothing unless
you explicitly enable it. If you run the kind of agent that must always be on the
latest build, set `{"updates": {"restartImmediately": true}}` in
`.instar/config.json`. A server restart does **not** close your sessions (they
resume via CONTINUATION); the only cost is a brief messaging blip while the
server bounces. `GET /updates/status` now reports `restartImmediately` so you can
confirm it's on.

## Summary of New Capabilities

- `updates.restartImmediately` config flag (default false). `UpdateGate` gains
  `alwaysRestartImmediately` (short-circuits `canRestart` to allow, never starts
  the deferral clock) + a runtime `setAlwaysRestartImmediately` setter; the
  `AutoUpdater` constructs the gate with it, skips the restart-window wait when
  set, and re-reads the flag each tick so a live config edit takes effect without
  a restart. The same-version cooldown + cascade dampener (loop protection) are
  preserved.
- Observability: both `UpdateGate.getStatus()` and `AutoUpdater.getStatus()` /
  `GET /updates/status` surface the active value.

## Evidence

- Spec: `docs/specs/restart-immediately-spec.md` (approved Telegram 13435,
  2026-06-01).
- Tests: `tests/unit/UpdateGate.test.ts` (+7: allow-despite-healthy-session,
  pure-no-deferral, monitor-not-consulted, default-still-blocks, runtime
  toggle both directions) and `tests/unit/AutoUpdater.test.ts` (+2: default
  false; `restartImmediately:true` reflected in status via the real gate). All
  19 UpdateGate + 18 AutoUpdater tests pass; `npm run lint` (tsc) clean.
