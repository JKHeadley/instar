# Remote desktop on Hyprland (Omarchy) — plain-English overview

> The one-line version: Instar's remote desktop now works on Hyprland, the Wayland desktop Omarchy uses, with nothing to install and no root access.

## The problem in one breath

Instar's Linux remote desktop reads and drives the screen with X11 tools. Omarchy runs Hyprland, which uses Wayland, where those tools see a black or partial screen. So on Omarchy the Desktop page told the person to choose an X11 session at sign-in, which Omarchy does not offer. People had assumed Wayland simply forbids this. On Hyprland it does not: the desktop offers these abilities to its own user's programs.

## What already exists

- The remote desktop itself: the dashboard's Desktop page, the PIN step, the encrypted stream, and the Stop button. None of that changes.
- The X11 host, which keeps working exactly as before.

## What this adds

A second Linux host for Hyprland, chosen automatically when the agent's user has a Hyprland session running:
- The picture comes from `grim`, about 60 to 160 milliseconds per frame on a small cloud server.
- Screens and the cursor position come from `hyprctl`.
- Typing goes through `wtype`, fed on standard input so a typed password never appears in the list of running programs.
- The mouse is a small client that speaks Hyprland's virtual-pointer protocol directly over its socket. That avoids ydotool, which would need root setup.

Omarchy already ships all of these tools. A plain Hyprland machine without `grim` or `wtype` is told exactly what to install.

## What I learned from the real machine

- When Omarchy's idle timer turns the display off, `grim` hangs. The host now wakes the screen by nudging the pointer when someone connects and whenever the screen goes off during a session.
- Omarchy's lock screen does not tell the system it is locked, so Instar cannot detect it. The viewer simply sees the password box and can type into it; I unlocked a real session that way.
- Hyprland's own Super-key shortcuts (like Super+Return for a terminal) do not fire from `wtype`. Shortcuts inside applications do work. The Omarchy menu icon works by mouse, and it reaches most of the same things. Holding a key while clicking (Ctrl-click) does not carry over either.

## The safeguards

- Nothing changes unless remote desktop is already turned on for this machine, with the same PIN and stream.
- A configured X display (`remoteDesktop.linuxDisplay`) always means X11.
- The host opens no network port and needs no root.
- It does not switch hosts while a viewer is connected, and if Hyprland goes away the viewer's session ends and says so.

## What the reader needs to decide

Nothing. It is off unless remote desktop is enabled, and a revert removes it.
