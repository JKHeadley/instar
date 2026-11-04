<!-- bump: patch -->

## What Changed

Four fixes from the locked-Mac proof run (the locked-screen feature itself stays off everywhere). The Mac desktop helper now creates its missing record folders (owner-only) and, when a record operation fails, says why in one fixed word that Instar passes on instead of a bare "unavailable". The locked-screen status now names, for the app and for a browser separately, whether a Mac password could be typed once the Mac is locked and what stands in the way (for example "tunnel-not-active" or "retained-helper-required"); the desktop viewer shows that reason instead of hiding the box, and an open viewer is told the moment the tunnel comes back. The Mac helper also reads who holds secure input from the right place now: before, it never could, so every password typed at a locked Mac was refused as "lock screen not confirmed". Every refusal now shows a plain sentence in the viewer and is recorded in the agent's logs. Every agent now gets a dashboard PIN at start if it has none, whether or not it uses Telegram, stored in its secret store when it has one; a PIN that already exists is never changed, and the PIN is no longer printed in logs.

## What to Tell Your User

If your agent runs without Telegram and never had a dashboard PIN, it has one now, so the dashboard's owner controls work. Ask me for it whenever you want to open the dashboard. If you already had a PIN, nothing changed.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Dashboard PIN for agents without Telegram | automatic at start; ask the agent for the PIN |
| Named reason why a locked Mac's password box is not ready | GET /desktop/locked/status → passwordReadiness; shown in the desktop viewer |
| Named reason when the Mac helper's record operation fails | appears in the locked-screen settings and status errors |

## Evidence

Real helper rebuilt and run: a missing nested store folder is created owner-only at every level; a blocked path answers "state-op: store-root-uncreatable" (exit 69). Unit tests: desktop-locked-proof-fixes, DesktopLockedController, DirectDesktopAccess.locked, tunnel-manager-rewrite, desktop-helper-state-op (real helper, 8/8).
