---
name: fleet-watchdog-peer-escalation
description: Fleet watchdog ships from source, escalates persistent failures to healthy peers
metadata:
  type: capability
  shipped: vNEXT
---

# Fleet Watchdog Peer Escalation

The fleet watchdog now ships from instar source (not hand-rolled) and includes two critical fixes:

## What Changed

1. **Watchdog script rebuilt with absolute-path resolution** — Uses absolute `/opt/homebrew/bin/node` + `npm-cli.js` instead of bare `npm`, so heal-step `npm install` survives launchd's empty PATH
2. **Peer escalation on persistent failure** — If an agent stays offline for ~15 minutes (3 failed heal cycles), the watchdog discovers a healthy peer and POSTs to that peer's `/attention` endpoint with the health alert
3. **Watchdog launchd plist gets explicit PATH** — Belt-and-suspenders next to the absolute-path resolution inside the script

## How Peer Escalation Works

- Detects 3 consecutive failed heal attempts (~15 min window) for the same agent
- Discovers a healthy peer agent on the same machine
- POSTs alert to peer's `/attention` endpoint with category `degradation`
- Peer's server routes alert through `MessagingToneGate` using standard B12-B14 health-alert ruleset
- If gate blocks (422), watchdog retries with canonical `SAFE_HEALTH_ALERT_TEMPLATE` so user always gets notified

## Behavioral Impact

When an agent crashes and won't auto-heal:
- **Single-agent machines**: No peer escalation (known gap; fix in v3 Self-Healing Remediator)
- **Multi-agent machines**: User receives plain-English Telegram message within ~15 min: *"[name] is offline — repair attempts aren't working — want me to dig in?"*

## Configuration

- `INSTAR_WATCHDOG_ESCALATE_AFTER` env variable controls threshold (default: 3 cycles = 15 min)

## Technical Notes

- Watchdog ships from `src/templates/scripts/instar-watchdog.sh`
- Migrated to existing agents via `PostUpdateMigrator.migrateFleetWatchdog()` on every `instar update`
- Tests: 4 integration tests in `tests/integration/fleet-watchdog-escalation.test.ts`
- Spec: `docs/specs/lifeline-shadow-install-self-heal.md`

## What You Need to Do

**Required**: `npm rebuild better-sqlite3` 

This rebuilds the durable message queue layer (Layer 2) that's currently disabled. Without it, escalation messages queue in memory only and can be lost on restart.

## Rollback

Revert `src/core/PostUpdateMigrator.ts` and `src/templates/scripts/instar-watchdog.sh`, redeploy. No persistent state migrations needed.
