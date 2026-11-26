---
title: Remote Desktop
description: Open and control an Instar agent's desktop from the dashboard.
---

Remote Desktop lets the operator use a machine where their Instar agent is installed. Open the agent's dashboard desktop page, enter the existing dashboard PIN, choose a ready machine, and press **Stop** when finished. When only one machine is ready, the viewer opens it directly. The live viewer fills the browser viewport. One finger moves the pointer like a trackpad, and a tap clicks. Two fingers move together to scroll or spread apart to zoom. When zoomed, two fingers pan the local view; **Fit** shows the whole desktop again. The floating keyboard button opens the phone's typing field, and the menu button reveals drag, direct touch, and shortcut controls. Rotate the phone to landscape for a wider desktop view.

On a laptop, move the mouse normally and use a two-finger trackpad scroll over the desktop. The **Trackpad / Direct** switch is for touchscreens only, so it is hidden when the browser has no touch input: Trackpad moves the remote pointer relative to your finger's movement; Direct puts the pointer at the position you touch. A mouse behaves the same in either touch mode. The viewer pointer has a black outline so it remains visible over white windows.

Each Mac needs an active desktop session plus macOS screen-recording and accessibility permissions. A Windows host whose Instar agent runs in WSL needs the packaged companion running in its signed-in Windows session; the Linux subsystem's display is not the Windows desktop. Every installation keeps remote control disabled until its own configuration explicitly enables it, and an enabled machine appears ready only after a live host probe passes.

## Across multiple machines

One designated machine serves the dashboard link for the pool. You enter its existing PIN once, then choose a ready machine by name. The selected machine decides whether it can grant control of its own screen and input; the dashboard machine passes encrypted stream bytes through without opening them. Stop closes that browser connection immediately and asks the selected machine to revoke its grant. If the machines lose contact, the selected machine expires the session after missed keepalives. Offline, locked, unprepared, and permission-denied machines remain listed with a reason instead of accepting an uncertain request. No Telegram approval or second credential is part of this flow.

## Control and limits

The PIN unlocks the existing dashboard session. That PIN session authorizes a short-lived grant for one target machine and one controller; it does not separately prove the person's identity. The video stream is encrypted for that grant. A session ends when its grant expires, the operator presses **Stop**, or authority is revoked. Stop blanks the viewer and stops native capture and input helpers. Video and input queues are bounded so a slow connection cannot accumulate unbounded work.

The Mac viewer prefers hardware H.264 and can fall back to JPEG when the browser or host cannot use that codec. The video ceiling is 15 frames per second at 1920 × 1080. The browser scales the image to fit its window; a laptop no longer receives a half-size copy of a 1080p Mac display. The viewer can ask for browser fullscreen where supported. Safari or Telegram may keep their own browser controls visible. Physical phone behavior and measured latency remain subject to device testing.

## API and implementation map

The dashboard uses the following authenticated routes. Applications should use the dashboard flow for operator control rather than building a separate PIN prompt.

| Route | Purpose |
| --- | --- |
| `GET /desktop/availability` | Check whether this installation can offer desktop access. |
| `GET /desktop/targets` | List machine targets and their readiness. |
| `POST /desktop/requests` | Create a scoped request for a target. |
| `GET /desktop/requests/:id` | Read the request and grant state. |
| `POST /desktop/requests/:id/resume` | Resume a disconnected stream under the existing grant. |
| `GET /desktop/requests/:id/cursor` | Read pointer position for local cursor feedback. |
| `POST /desktop/requests/:id/ticket` | Obtain a short-lived stream ticket. |
| `POST /desktop/requests/:id/revoke` | End control and revoke the grant. |

`DirectDesktopAccess` owns admission, one-controller enforcement, expiry, and revocation. `RemoteStepUpLockouts` bounds PIN attempts. `DesktopHost` is the platform interface and `MacDesktopHost` is the first implementation. `DesktopVideo` defines bounded video frames, `DesktopAead` protects the stream, and `DesktopAccessAudit` records content-free control events. `DesktopStreamManager` connects the grant to the live browser stream. The approved architecture and rollout gates are described in `docs/specs/blocker-handoff-across-machines-and-surfaces.md` and `docs/specs/native-remote-desktop-quality.md` in the repository.

For the mesh path, `DesktopOperatorAssertion` binds the PIN-authorized browser request to the selected machine; `DesktopAssertionReplayStore` prevents a signed request from being reused, and `DesktopDelegatedSessionStore` holds the target's short-lived delegated session. On Windows, `WindowsDesktopCompanionDiscovery` locates the companion from WSL and `WindowsDesktopHost` sends authenticated capture and input requests to that companion. The target still owns its screen permissions, controller lock, and Stop decision.

For support, `GET /capabilities` shows which server capabilities are installed, `POST /telegram/dashboard-refresh` refreshes the dashboard link sent through the existing Telegram bot, and `GET /mesh/rope-health` reports cross-machine link health where that monitor is enabled. These diagnostic routes do not grant desktop control or replace the dashboard PIN.
