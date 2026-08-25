# "Starts automatically" didn't mean at boot on Linux — Plain-English Overview

> The one-line version: on Linux, instar set itself to start automatically and then told you it would start when you log in — which on a machine nobody logs into means never; this turns on the missing setting, checks it actually worked, and says which of the two is really true.

## The problem in one breath

`instar autostart install` on Linux writes a correct startup service, switches it on, starts it, and reports "your agent will start automatically when you log in." That sentence is true and useless: on Linux a per-user service only runs while that user has a login session open, and it does not start when the machine boots unless a separate setting is turned on. It wasn't. On a headless machine the agent came up when someone connected over SSH and died the moment they disconnected.

## What already exists

- **`instar autostart install`** — sets your agent to start on its own, so you don't have to launch it by hand after a restart.
- **The macOS path** — writes a login item. Works, and has always worked, because on a Mac somebody is logged in.
- **The Linux path** — writes a systemd user service, enables it, and starts it. Every one of those steps genuinely succeeds. The gap is the step nobody wrote.

## What this adds

After enabling the service on Linux, instar now also tries to turn on "lingering" — the setting that lets your account's services keep running when you're not logged in, which is what makes them start at boot. Then it checks whether that actually worked, and prints the truth accordingly rather than an unconditional promise.

- If lingering is on, it says the agent will start when the machine boots with nobody logged in.
- If turning it on was refused (it usually needs administrator rights), it says plainly that the agent starts at login but **not** at boot, that on an unattended machine this means never, and gives you the exact one-line command to fix it.
- If the system can't answer the question at all — a container, or a Linux without this component — it says the agent starts at login and that boot behaviour couldn't be determined, rather than guessing.

## The new pieces

- **A lingering check** — asks the system whether your account's services survive logout. It deliberately distinguishes "no" from "couldn't ask", because those need different answers and merging them would print a fix instruction that cannot work where it doesn't apply.
- **A lingering enabler** — tries to turn it on, then *re-reads the state to confirm it took effect*. It does not trust the command's exit code, because a step reporting success while producing no effect is the exact defect being fixed here.
- **An honest message** — one sentence per real outcome, replacing one sentence used for all of them.

## The safeguards

**It never escalates privilege behind your back.** Turning on lingering usually requires administrator rights. Instar tries the plain command; if the system refuses, it tells you the command to run rather than quietly reaching for `sudo`. A setup step that silently escalates is worse than one that asks.

**It cannot claim success it didn't achieve.** The outcome is established by reading the state back afterwards, not by the command exiting cleanly. A command that returns success and changes nothing is reported as "not done", which is the honest answer and the one that gets the agent actually running.

**It doesn't make the install fail.** A service that works at login is still a working install — it's just not the thing the old message claimed. The install still succeeds; only the description of what you got becomes accurate.

**macOS is untouched.** Not a line of the Mac path changes, and lingering is a Linux-only concept.

## What ships when

One change, one PR: the lingering attempt, the verification, the honest message, and twelve tests — including a regression guard asserting the old unconditional sentence is never printed for an outcome that doesn't deserve it.

## What you actually need to decide

Whether instar should attempt to enable lingering during a Linux auto-start install and report which of "starts at boot" or "starts at login only" is actually true — rather than always claiming the second — yes or no.
