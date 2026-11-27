# Side-Effects Review — remote desktop on Hyprland (Omarchy)

**Version / slug:** `hyprland-remote-desktop`
**Date:** `2026-11-03`
**Author:** `Echo`
**Tier:** `1 declared; the gate's risk floor is 2 for a new capability. Reasoning: off unless remote desktop is enabled, no state, a revert restores everything. Two independent review rounds and live proof took the place of a converged spec. Recorded as belowFloor.`
**Second-pass reviewer:** `independent subagent, two rounds. First: concern raised (two high, two medium, five low; Stop safety and races), all fixed. Second: the fixes held; concern raised (capitals lost from a physical keyboard, confirmed live; two low restart races; weak tests), all fixed`

## Summary of the change

Topic 136848 asked what Wayland remote desktop would take on Omarchy (Hyprland). This builds it for Hyprland, and proves it on Omarchy 4.0.6 on a Hetzner server.

- `src/core/HyprlandDesktopHost.ts` is a new `DesktopHost`: `grim` for frames, `hyprctl -j` for screens and cursor, `wtype` for keys (text on stdin), and a virtual pointer for the mouse.
- `src/core/WaylandVirtualPointer.ts` speaks `zwlr_virtual_pointer_v1` directly over the Wayland socket. No package and no root.
- `LinuxAutoDesktopHost`, in the same file as the Hyprland host, picks Hyprland or the existing X11 host at each probe, stays put while a viewer is connected, and always uses X11 when `remoteDesktop.linuxDisplay` is set.
- `DesktopProbeReadiness` gains wording for Hyprland with nobody signed in, with tools missing, and not answering. The generic Wayland wording no longer claims Wayland cannot be supported.
- `LinuxRunner` gains an optional `input` written to the child's stdin.
- The remote desktop awareness bullet mentions Hyprland. `migrateClaudeMd` already replaces that line in place for existing agents.

## Class-Closure Declaration

- `unbounded-self-action`: closure `n/a`. The only timer is the 2 s heartbeat of an operator-started remote desktop session, the same as the X11 host. It stops on Stop, on a lost desktop, and at the session's ten-minute limit, and it nudges a display only when it has gone off.

## Decision-point inventory

- Which host serves a Linux machine: add; Hyprland when this user has a live session and no X display is configured, otherwise X11, re-decided at each probe unless a viewer is connected.
- Whether a Hyprland desktop counts as ready: add; tools present, session live, at least one monitor.

## 1. Over-block

A Wayland session on Hyprland used to refuse and now works, unless `grim` or `wtype` is missing, which reports what to install. Other Wayland desktops refuse as before.

## 2. Under-block

Remote desktop reports `screenLocked: false` on Hyprland because Omarchy's lock screen leaves logind's `LockedHint` at no, so the X11 host's locked refusal has no equivalent. A viewer who has passed the dashboard PIN sees the lock screen and can type at it, but still needs the machine's password; the frames show only the lock screen. Measured: typing the password through this path unlocked a real session.

The virtual pointer and `wtype` run as the agent's user, the same trust as `xdotool` on X11.

## 3. Level-of-abstraction fit

The same `DesktopHost` interface as the other hosts, so admission, the PIN, the audit log and the stream are unchanged. Selection sits in a small wrapper instead of inside the X11 host, so the X11 host's code path is untouched apart from the optional stdin field.

## 4. Signal vs authority compliance

No message or action is gated by this. `probe()` already feeds the existing admission decision and this reports the same fields honestly.

## 4b. Judgment-point check

None.

## 5. Interactions

- **X11 host:** still used on every machine without a Hyprland session. A Hyprland login also owns an Xwayland socket, which the X11 host deliberately refuses; the wrapper now selects Hyprland before that arises.
- **`linuxDisplay` set to `:0` on a Hyprland machine:** still X11, as asked, even though it shows a partial screen.
- **Display idle:** the heartbeat nudges the pointer when a screen goes off during a session, so the display stays on while something off-screen turned it off. It does not reset idle continuously, so Omarchy can still lock during a long quiet session, and the viewer sees the lock.
- **Machine with a stale `hypr` folder:** ignored unless its recorded pid is running and its socket exists.
- **Hyprland restart while connected:** the heartbeat sees the signature change and ends the session through the existing lost-indicator path; the viewer can reconnect.
- **`hyprctl dispatch`:** deliberately unused; it became Lua in Hyprland 0.56.
- **Older grim or wtype:** the flags used are long-standing, and `wtype -` for stdin was checked on this machine only.
- **Page errors on Linux:** the Desktop page's calls to `/desktop/locked/status` and `/desktop/setup` answer 503 on this host, as those belong to the macOS locked-screen and setup features. The page carries on, and they appear in the browser console only. One `cursor` call answered 403 in the moment before the session was admitted.

## 6. External surfaces

A notification on the machine's own screen when a viewer connects, the same as X11. Nothing new leaves the machine and no port opens.

## 7. Multi-machine posture

Machine-local by design: each host describes its own screen, and the existing pool Desktop page lists machines as before.

## 8. Rollback cost

A revert restores the X11-only behaviour. Nothing is stored.

## Known limits

- Hyprland's own Super-key shortcuts do not fire from `wtype`, tried four ways; shortcuts inside applications reach them (Ctrl+L, measured). Queued as an improvement.
- Modifiers do not reach the mouse: Ctrl-click, Shift-click and Super-drag lose the modifier, because the virtual pointer and `wtype` are separate clients. X11 supports these.
- A press-and-hold of a non-modifier key sends one key, because `wtype` presses and releases within one run. A modifier tapped alone (Super by itself) sends nothing.
- Shift plus a key is sent as the character it makes on a US keyboard, because `wtype` chords lose capitals and shifted symbols (measured). Another layout's shifted digits will differ; letters are fine. The viewer's keyboard field, which sends text, is not affected.
- Stop blocks new input at once but does not kill a `wtype` already running, the same as `xdotool` on X11.
- A Hyprland restart during a session is covered by unit tests, not live.
- Single keys sent as key presses appear in the process list briefly (`wtype -k a`), as they do with `xdotool` on X11. Text sent through the viewer's keyboard field and pasted text go over stdin.
- A crash of the agent while a button is held relies on the compositor to release it, which was not tested. Normal Stop sends the release first and closes gently so it arrives.
- More than one monitor is covered by unit tests only; the test server has one screen.
- This has unit tests and live proof, not integration or e2e tier tests. Those tiers need a running Hyprland, and CI has none; the wiring is pinned by a source test, and the existing desktop route tests use the same host interface with a stub.

## Tests

- `tests/unit/hyprland-desktop-host.test.ts` (37 tests): session discovery (live, dead, junk); monitor parsing (scale, sideways, disabled, idled off); probe readiness and its three wordings; capture and screen choice; pointer mapping; clicks, drags, Stop releasing, including in a click's gap; scroll remainders; typing on stdin; modifier chords; waking a display; losing the desktop; Stop during connecting; a late connect; a failed start; nothing reopening the pointer after Stop; shared connection; a stale heartbeat not ending the next session; host selection and its X11 override; and the wire bytes against a fake compositor on a real Unix socket.
- `tests/unit/linux-desktop-host.test.ts` and `tests/unit/remote-desktop-delivery-parity.test.ts` unchanged and passing.
- Live, Omarchy 4.0.6, Hyprland 0.56.2, agent limited to 2 vCPUs and 3.9 GB (the size of a cx23), through the real dashboard Desktop page over Tailscale with the PIN: diagnostics `status: ready`; the live desktop streamed; a click opened Omarchy's menu; typing through the viewer's keyboard field and as direct keys both arrived in order, including spaces (Shift keys through the host class on the final build typed `xA!By` as sent); Ctrl+L cleared a terminal; wheel scrolled its history; a held drag selected text; Stop reported stopped and left no pointer socket; reconnect worked. Over 1,397 captures, 0 failed. A display turned off before connecting came back on connect, and one turned off mid-session came back within 4 s. `wtype` on stdin unlocked the real lock screen.
