## What Changed

The Desktop page and the app now offer guided setup. After the PIN, each machine that is not ready shows its one next step, taken from a live check on that machine: turn it on and restart it, wake or unlock it, allow a pop-up, open the exact System Settings page, or the written path. Readiness is decided only by the live check. The page says so, because the System Settings list can look empty or show several entries when the permission works. New routes: `GET /desktop/setup`, `GET /desktop/setup/:machineId`, `POST /desktop/setup/:machineId` (PIN session required; a Bearer token alone is refused), and the signed machine route `POST /api/desktop/setup`. A paired machine can now claim a machine that has no front yet, without that machine seeing a PIN; that raises a high-priority attention item, is logged in `logs/desktop-setup.jsonl`, and Turn off undoes it. The picker now names peers by the pool's nickname, not the peer's own copy. Guided setup is live on a development agent and dark on the fleet (`remoteDesktop.guidedSetup.enabled`); the picker's label fix applies everywhere.

## What to Tell Your User

Setting up Remote Desktop no longer needs me to change anything by hand. Open the Desktop page, enter your PIN, and each machine that is not ready shows one next step and rechecks by itself. Go by that page, not by the list in System Settings, which can be misleading.

## Summary of New Capabilities

- Guided Remote Desktop setup per machine on the dashboard and in the app.
- A Turn off action for Remote Desktop on any machine, from its front.

## Evidence

Unit, integration and end-to-end tests cover every guide state, the front ownership check, the refusal on a locked Mac, and the production boot with desktop off (the page is alive, turn-on writes the real config and requests a real restart). The Mac Lan label was measured: the M5's own registry says `Mac Lan` while the Studio's says `Mac M5 Pro`. No real machine's config was changed and no real prompt was shown while building this, so the real-Mac path is not yet proven: a real pop-up, the real settings page and a real turn-on across two machines have not been run.
