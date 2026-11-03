# Remote desktop on native Linux machines (X11)

<!-- bump: patch -->

## What Changed

- A native Linux machine (not WSL) can now be a remote desktop target. It shares the agent user's own X11 session, either a desktop login or a virtual one such as TigerVNC or Xvfb, through ImageMagick `import`, `xdotool` and `xrandr`. No VNC or other port is opened: the picture and the input travel on the same signed, encrypted desktop stream as Mac and Windows, behind the same PIN, grant, Stop and audit.
- Guided setup no longer says "Linux is not supported". A Linux server with no X display, a Wayland login, a locked screen, a missing capture tool or a display that stopped each reports not ready with a plain reason.
- Optional `remoteDesktop.linuxDisplay` (e.g. `":1"`) picks the display when there are several. WSL machines keep using the Windows companion.
- The CLAUDE.md remote-desktop section says what Linux supports; existing agents get it through the existing migration.

## What to Tell Your User

Your Linux machines can now show up in Remote Desktop, like your Macs and Mama PC. A Linux machine needs a desktop running as the agent's user. A cloud server can use a virtual desktop such as TigerVNC. Turn it on from the Desktop page, the same way as the other machines. If a machine has no desktop, or uses the newer Wayland desktop, the page says so instead of showing a blank screen.

## Evidence

- Unit tests: headless refusal, Wayland refusal, locked screen (screen lockers and logind's lock hint), input mapping on one screen and on a chosen screen, scroll conversion, Stop releasing held keys and buttons, no input sent after Stop, and a vanished display ending the session.
- Live on Cirrus (Ubuntu 24.04, TigerVNC display :1), standalone: probe ready, about 15 frames a second at about 150 KB each, cursor placed correctly, capture refused after Stop. The full path through the app is verified on Cirrus after release.

## Summary of New Capabilities

- Native Linux (X11) remote desktop target.
- `remoteDesktop.linuxDisplay` config option.
