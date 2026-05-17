# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Three coordinated changes that close a fleet-wide outage class observed on 2026-05-17: AI Guy crash-looped for ~4 days after its `shadow-install/` directory vanished, and no alert reached the user because the fleet watchdog's self-heal was failing silently under launchd's empty PATH.

1. **Boot wrapper self-heals missing shadow-install** (`src/commands/setup.ts`).
   When `instar-boot.cjs` or `instar-boot.sh` finds no `shadow-install/node_modules/instar/dist/cli.js`, it now attempts ONE `npm install` (resolved via absolute `/opt/homebrew/bin/node` + `npm-cli.js` to survive launchd's empty PATH) before exiting. Debounced by a `.heal-attempted` marker file so launchd KeepAlive throttling can't trigger a reinstall storm. This alone would have recovered AI Guy within seconds.

2. **Fleet watchdog ships from instar source** (`src/templates/scripts/instar-watchdog.sh`, new). The user-machine fleet watchdog at `~/.instar/instar-watchdog.sh` now ships from the repo, with two behavior fixes vs the prior hand-rolled version:
   - Heal-step `npm install` uses absolute-path `node` + `npm-cli.js` resolution instead of bare `npm` (which silently fails under launchd PATH).
   - When self-heal fails for 3 cycles in a row for the same agent (~15 min), the watchdog discovers a healthy peer agent and POSTs to that peer's `/attention` endpoint with `category: degradation`. The receiving server routes the alert through `MessagingToneGate` with the B12-B14 health-alert ruleset (the same authority `DegradationReporter` already uses in-process). On 422 (gate block) the watchdog retries with the canonical `SAFE_HEALTH_ALERT_TEMPLATE` so the user always learns SOMETHING when an agent stays dead.

3. **Watchdog launchd plist sets PATH explicitly** (`src/core/PostUpdateMigrator.ts:migrateFleetWatchdog`, new). Belt-and-suspenders next to the absolute-path resolution inside the script.

The fleet watchdog and its launchd plist are now migrated to every existing agent on `instar update` and installed on every fresh agent setup.

## What to Tell Your User

If an agent on your machine ever crashes in a way the watchdog can't auto-fix (network issues, disk full, etc.), you'll now get a plain-English Telegram message from one of your healthy agents within ~15 minutes: *"[name] is offline — repair attempts aren't working — want me to dig in?"* No more silent 4-day outages.

If you ONLY have one agent on a machine, peer escalation isn't available — you'd still need to notice via the dashboard or by trying to message the agent. Single-agent machines are a known gap; the long-term fix lives in the v3 Self-Healing Remediator's Tier-3 Fleet Intelligence.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Boot-wrapper auto-reinstalls missing shadow-install | Automatic on next agent restart after this update |
| Fleet watchdog ships from source + migrates to existing agents | Automatic via `PostUpdateMigrator.migrateFleetWatchdog()` on every `instar update` |
| Cross-agent peer escalation on persistent agent failure | Automatic; configure threshold via `INSTAR_WATCHDOG_ESCALATE_AFTER` env (default 3 cycles = 15 min) |

## Evidence

- Spec: `docs/specs/lifeline-shadow-install-self-heal.md` (with ELI16 companion `.eli16.md`)
- Side-effects review: `upgrades/side-effects/lifeline-shadow-install-self-heal.md`
- Tests: `tests/unit/lifeline-shadow-install-self-heal.test.ts` (14 tests), `tests/integration/fleet-watchdog-escalation.test.ts` (4 tests)
- Incident reference: AI Guy outage 2026-05-13 → 2026-05-17, topic 5447

## Rollback

Pure code change. Revert the three source files (`src/commands/setup.ts`, `src/core/PostUpdateMigrator.ts`, `src/templates/scripts/instar-watchdog.sh`) and ship as a patch. No persistent state migrations needed; marker files and per-label fail counters are harmless if left behind.
