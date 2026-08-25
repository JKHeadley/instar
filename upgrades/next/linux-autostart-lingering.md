---
change_type: fix
---

## What Changed

`instar autostart install` on Linux wrote a systemd **user** service, enabled it, started it, and
reported *"Your agent will start automatically when you log in."* Every one of those steps genuinely
succeeded — and the sentence was true in a way that meant **never** on a machine nobody logs into.

A per-user systemd service only runs while that user holds a login session. It does **not** start at
boot unless **lingering** is enabled for the account, and nothing enabled it or said so. On a headless
host the agent came up when someone connected over SSH and died the moment they disconnected.

`installLinuxSystemdService` now calls a new `ensureLinuxLingering()` after enabling the unit. It
reads the current linger state, attempts `loginctl enable-linger <user>` when it is off, and then
**re-reads the state to verify the effect** rather than trusting the exit code — a command that
returns success while changing nothing is reported as not done, because that is the exact defect
class being fixed. The outcome reaches the CLI, which prints what actually happened:

- **starts at boot** — lingering is on, with nobody logged in.
- **starts at login, NOT at boot** — the attempt was refused (it usually needs root). The message says
  plainly that on an unattended machine this means never, and names the exact one-line fix.
- **starts at login; boot behaviour undetermined** — no `loginctl` on this system (a container, a
  non-systemd distro). No fix instruction is printed, because it would not work there.

There is deliberately **no `sudo` attempt**. A setup step that silently escalates privilege takes an
authority the operator did not grant it; naming the command keeps that decision with the human. The
install still returns success in every case — a login-only service is a working install, it is just
not the thing the old message claimed.

macOS is untouched, and Windows already returns false.

## Evidence

Found on the first headless Linux host — WSL2 / Ubuntu 26.04. The reproduction is the contradiction
itself: `instar autostart install` reported success and `systemctl --user is-enabled` returned
`enabled`, while `loginctl show-user echo -p Linger` returned `Linger=no` — an enabled service that
would never start at boot.

Both live paths were exercised against a real `loginctl` on that host: an account with lingering on
returns `enabled-already`, and an unknown account returns `unavailable` rather than being
misreported as "off". That second case also surfaced a smaller leak now fixed — `loginctl` writes
`Failed to look up user <x>` to stderr, which was reaching the operator's terminal on a path the
code handles cleanly; stderr is now piped.

12 unit tests. Both parse directions; the unanswerable case kept distinct from "no" (they need
different answers, and merging them would print a fix instruction that cannot work where it does not
apply); the already-on path asserting the privileged command is **not** re-run; verification-over-exit
-code, where a fake enable that exits 0 and changes nothing yields `needs-privilege`; a polkit
refusal; a blind-enable guard asserting the command is never run when the state is unreadable; and
four message assertions — including a regression guard that the old unconditional sentence is never
rendered for an outcome that does not deserve it.

The two failure paths are covered by injected dependencies rather than by breaking a live machine's
configuration, which is stated here rather than implied.

## What to Tell Your User

If you run instar on Linux, "auto-start installed" has not meant "starts when the machine boots" — it
meant "starts when you log in", and on a machine you never log into that is never. That is why an
agent on a headless Linux box could come up when you connected and vanish when you disconnected.

Instar now turns on the missing setting where it can, and where it cannot (it usually needs
administrator rights) it tells you so plainly and gives you the one command to run. Nothing changes
on macOS.

## Summary of New Capabilities

No new capabilities. A Linux auto-start install now completes the step it was missing, and reports
which of "starts at boot" or "starts at login only" is actually true.
