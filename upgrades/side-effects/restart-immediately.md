# Side-Effects Review — Primary-developer mode (`updates.restartImmediately`)

**Slug:** `restart-immediately`
**Date:** 2026-06-01
**Author:** echo
**Spec:** `docs/specs/restart-immediately-spec.md` (approved by Justin, Telegram topic 13435)

## Summary of the change

A per-agent, opt-in config flag `updates.restartImmediately` (default **false**).
When true, the agent's update restarts are never deferred — not for active
sessions (UpdateGate) and not for the restart window (AutoUpdater) — so it always
rolls onto the latest version as soon as it is downloaded. Intended for the
instar developer's own agent; explicitly **not** a fleet default.

**Files changed (source):**
- `src/core/UpdateGate.ts`:
  - `UpdateGateConfig.alwaysRestartImmediately` (default false) + a constructor
    default + `UpdateGateStatus.alwaysRestartImmediately`.
  - `canRestart()` short-circuits at the very top when the flag is set:
    `reset()` + return `{ allowed: true }` *before* listing sessions, so the
    deferral clock never starts and the session monitor is never consulted.
  - new `setAlwaysRestartImmediately(value)` — runtime toggle (clears an
    in-flight deferral when turned on) for live `LiveConfig` edits.
- `src/core/AutoUpdater.ts`:
  - `AutoUpdaterConfig.restartImmediately` (default false) + constructor default;
    constructs `UpdateGate` with `{ alwaysRestartImmediately: this.config.restartImmediately }`.
  - `gatedRestart()` skips the restart-window deferral when the flag is set
    (session gate already satisfied inside `UpdateGate`).
  - `reloadDynamicConfig()` re-reads `updates.restartImmediately` (both the
    `LiveConfig` path and the file-read fallback) and pushes changes into the
    gate via the setter.
  - `AutoUpdaterStatus.restartImmediately` (sourced from the gate's status).
- `src/commands/server.ts`: maps `config.updates?.restartImmediately ?? false`
  into the `AutoUpdater` config at construction.
- `src/core/types.ts`: `UpdateConfig.restartImmediately?: boolean` (typed).

**Files changed (tests):**
- `tests/unit/UpdateGate.test.ts` — +7 (new `alwaysRestartImmediately` describe):
  allow-despite-healthy-active-session (with a baseline assertion that the same
  fixture blocks by default), pure-no-deferral-clock, monitor-never-consulted,
  default-false-still-blocks, runtime setter true→allowed (clears deferral) and
  false→blocks again.
- `tests/unit/AutoUpdater.test.ts` — +2: default `restartImmediately` false;
  `restartImmediately:true` reflected in `getStatus().restartImmediately`
  (sourced from `gate.getStatus()` — proves the flag reached the real gate).

## Blast radius

Default false ⇒ **zero fleet impact**. With the flag unset, `canRestart` runs
exactly as before (the new branch is skipped), `gatedRestart`'s window check is
unchanged (`!this.config.restartImmediately` is true), and the gate is
constructed with `alwaysRestartImmediately: false`. All 19 existing UpdateGate +
18 existing AutoUpdater tests pass unmodified.

## Behavior delta

| Scenario | Before | After (flag OFF — default) | After (flag ON) |
|---|---|---|---|
| healthy active session + update ready | defer indefinitely | defer indefinitely (unchanged) | restart now |
| outside restart window + update ready | defer to window | defer to window (unchanged) | restart now |
| same version within 30 min | cooldown skip | cooldown skip (unchanged) | cooldown skip (preserved) |
| two releases within ~15 min | dampener coalesces | dampener coalesces (unchanged) | dampener coalesces (preserved) |
| sessions during restart | survive (CONTINUATION) | survive | survive (unchanged) |
| `GET /updates/status` | no field | `restartImmediately: false` | `restartImmediately: true` |

## Risks considered

- **Does it kill sessions?** No. A server restart bounces the server process;
  tmux sessions survive and resume via CONTINUATION. The flag changes *when* the
  server restarts, never *whether* sessions survive.
- **Restart loop / storm?** The same-version 30-min cooldown and the cascade
  dampener are deliberately preserved — only genuinely back-to-back distinct
  releases coalesce (≤15 min), and a flapping single version cannot re-restart.
- **Accidental fleet-wide enablement?** Default false + no `migrateConfig` entry
  ⇒ existing and new agents are false-by-absence; only an explicit per-agent
  config edit turns it on. This is intentional (the directive forbids a fleet
  default).
- **Stale cached flag after a live edit?** `reloadDynamicConfig()` re-reads it
  each tick and pushes it into the gate, and the setter clears any in-flight
  deferral — so enabling it on disk takes effect at the next tick without a
  restart.

## Migration parity

No agent-installed file changes (no hook/skill/CLAUDE.md template). A new config
default is normally added to `migrateConfig()` — **intentionally not done here**:
the flag must default to false for the fleet, and absence already yields false in
code. Adding a fleet migration that set it true would violate the directive
("not for all instar agents"). Echo's own `.instar/config.json` is set directly
(operational, outside this PR).

## Tests / lint

19 UpdateGate (+7 new) + 18 AutoUpdater (+2 new) tests pass; `npm run lint`
(tsc + destructive/LLM/URL-log/codex-drift) clean.
