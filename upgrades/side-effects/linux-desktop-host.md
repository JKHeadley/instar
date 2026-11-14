# Side-Effects Review — Native Linux remote desktop host (X11)

**Version / slug:** `linux-desktop-host`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Adds `src/core/LinuxDesktopHost.ts`, a `DesktopHost` for native Linux (not WSL) that shares the agent user's own X11 session using `import` (ImageMagick), `xdotool` and `xrandr`, run with `execFile` (no shell) under the agent's own X authority. `AgentServer` builds it when `process.platform === 'linux' && !isWslHost()` and the existing `remoteDesktop.enabled` opt-in is on; WSL keeps the Windows companion. Guided setup (`DesktopSetupGuide`, `DesktopSetupTarget`) no longer refuses native Linux. `DesktopProbeReadiness` gives Linux-specific reasons (no X display, locked, display gone, capture tool missing) instead of Mac wording. `DesktopPlatform` gains `'linux'`, `RemoteDesktop` config gains optional `linuxDisplay`, and the CLAUDE.md remote-desktop bullet (migrated by the existing replace-on-differ logic in `PostUpdateMigrator`) says what Linux supports. Spec: `docs/specs/blocker-handoff-across-machines-and-surfaces.md` ("Linux desktop with ... OS-supported capture/input APIs ... no raw VNC/RDP port is exposed").

## Decision-point inventory

- `DirectDesktopAccess.probe()` readiness — pass-through — the Linux probe feeds the existing `screenPermission && inputPermission && displayCount > 0 && sessionActive` rule; nothing new decides admission.
- Guided setup `turn-on` refusal for native Linux — remove — native Linux can now be turned on like any other machine; the live probe still decides readiness.
- Host selection in `AgentServer` — modify — native Linux gets `LinuxDesktopHost` instead of an unreachable Windows companion.

---

## 1. Over-block

A Wayland login reads as not ready, detected from logind's session `Type` because its Xwayland socket would otherwise answer X tools and show a black or partial screen; an explicitly configured `linuxDisplay` (for example an Xvfb beside it) is still trusted. That is truthful: Wayland compositors do not allow this capture/input, and the reason names the missing X display. A machine where the agent runs as a different user from the desktop login is refused (socket owned by another uid) unless `remoteDesktop.linuxDisplay` names it and the X authority allows it; that is the intended boundary.

## 2. Under-block

Screen-lock detection asks xfce4/gnome/mate/xscreensaver and systemd-logind's `LockedHint` for the user's active graphical login (covers light-locker and GNOME's shield). A locker known to neither (e.g. bare i3lock on a virtual X server) reads as unlocked, so the viewer would show the lock screen itself. That shows a lock screen, not a bypass: input still goes to the locker. No visible on-screen indicator beyond a best-effort desktop notification (`notify-send`); Mac shows a persistent one. The Stop path, ten-minute grant, controller lock and audit are unchanged and live in `DirectDesktopAccess`.

## 3. Level-of-abstraction fit

Correct layer: the `DesktopHost` contract was written for exactly this ("A Windows or Linux companion implements this contract"). Grants, PIN, step-up, encryption and revocation remain in `DirectDesktopAccess`/`DesktopStreamManager`; the host only captures and injects.

## 4. Signal vs authority compliance

The host holds no admission authority. Its probe is a signal consumed by the existing readiness rule; capture and input refuse unless the grant's indicator is active (authority stays with the grant).

## 4b. Judgment-point check

No competing-signals decision added; the lock-reading heuristic only produces a probe field.

## 5. Interactions

macOS path untouched (`macHost` still wins). WSL path untouched (`isWslHost()` keeps the Windows companion). Input is serialized through one promise queue with a generation counter, re-checked immediately before every xdotool command (after each await), so nothing is sent after Stop. Presses are recorded as held before they are sent, so Stop releases a press that landed but timed out. The 2-second heartbeat ends the grant through the existing `onUnexpectedExit` when the X display disappears.

## 6. External surfaces

New: Linux machines appear as settable/ready in the Desktop page and the app when their X session answers. No network listener is opened; capture and input travel only on the existing encrypted stream. Arguments go to `execFile` (no shell); typed text goes after `--`; key names are mapped from a fixed table; the display name is validated (`:N[.M]`).

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each Linux machine shares only its own X session; the front relays as for Mac/Windows. No new replicated state.

## 8. Rollback cost

Set `remoteDesktop.enabled: false` on the Linux machine (existing switch), or revert the PR; no data or migration to undo. The CLAUDE.md bullet is rewritten by the existing migrator on the next update.

## Conclusion

Ships a Linux host behind the existing per-machine opt-in. Live-verified standalone on Cirrus (Ubuntu 24.04, TigerVNC :1): probe ready, 14.7 frames/s at ~150 KB, cursor placement within 0.01, capture refused after Stop. The production path (front → grant → app) is verified after release on Cirrus before Linux is described to the operator as usable.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (fresh context), 2026-11-02 20:38 PST
**Independent read of the artifact:** concern, then resolved. It raised four concerns: (1) input could still be sent after Stop when Stop landed during the coordinate lookup, and a press could stay held; (2) a press that took effect but timed out was never released; (3) a Wayland login's Xwayland socket would probe ready; (4) common lockers without a query command read as unlocked. All four are fixed (per-command generation check, held-before-send tracking, logind Type/LockedHint) with tests: `sends nothing after Stop…`, `releases a press on Stop even when the press itself timed out`, `refuses a Wayland login…`. It concurred on argument safety (execFile, `--` before text, fixed key table, validated display), coordinate mapping, the untouched Mac/WSL paths, and the setup guide/target changes.

## Evidence pointers

- `tests/unit/linux-desktop-host.test.ts` (headless refusal, lock, input mapping, Stop release, display loss)
- Live run on Cirrus, 2026-11-02 20:16 PST (output recorded in topic 131439)

## Follow-up (2026-11-02 22:47 PST)

Local Verify flagged the heartbeat catch in `startIndicator` under the no-silent-fallbacks ratchet (495 over 494). The catch is not silent: it ends the grant through `onUnexpectedExit`. It now carries an in-window `@silent-fallback-ok` marker saying so; no behavior changed.
