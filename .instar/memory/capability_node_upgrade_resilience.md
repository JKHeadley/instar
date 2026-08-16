---
name: Node.js In-Place Upgrade Resilience
description: Auto-update migration handles stale process.execPath gracefully
type: feedback
---

**The fix**: Post-update migration now checks if `process.execPath` still exists before using it. If the Node.js binary has been deleted (in-place upgrades via Homebrew), it falls back to spawning `node` from PATH instead of failing with ENOENT.

**Why it matters**: When Homebrew upgrades Node in place (e.g., `/opt/homebrew/Cellar/node@22/22.x.x/bin/node` → newer version path), the old binary is deleted. If instar was running during the upgrade, the next auto-update would try to spawn `process.execPath`, fail silently, and skip applying migrations. This left the agent config stale.

**How to apply**: Automatic. No action needed — just know that auto-updates are now more reliable across Node version transitions.
