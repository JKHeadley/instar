---
title: "Windows sign-in repair: the repair helper signs in through Windows Chrome"
slug: "windows-signin-repair"
author: "echo"
eli16-overview: "docs/specs/windows-signin-repair.eli16.md"
parent-principle: "Self-Unblock Before Escalating"
depends-on:
  - skill-driven-signin-repair
  - normal-chrome-cross-platform
---

# Windows sign-in repair

## Problem

The automatic sign-in repair hands the browser step to a helper session, on macOS only. An agent in WSL on a Windows machine fell back to an automated Chrome that cannot open a Windows profile, and auth-sensitive sign-ins never run in an automated browser. So a signed-out account on the Mama PC stayed signed out (CMT-609, CMT-1046).

A live test from a background session on the Mama PC (2026-10-31) showed the Windows driver itself is healthy: `ndrive.sh` answered through its bridge and PowerShell read `%LOCALAPPDATA%`. The recorded `state-unavailable` and `wslpath` failures did not reproduce. No driver change is made.

## Design

1. `resolveReloginNavigation` honors an explicit `agent-session` on WSL. WSL is read from the kernel release, because a systemd service has no `WSL_*` variables. It stays off unless configured: omitted still means the existing driver.
2. A profile gains an optional `windowsUserDataDir`, set by `PATCH /playwright-profiles/:id`. The Linux `userDataDir` stays metadata there. `dirExists` then checks the folder under `/mnt/<drive>`.
3. On WSL, admission counts a profile with no Windows folder as `profile-directory-missing`, so `blockers` names the reason.
4. The helper prompt gets a Windows form: `ndrive.sh` tools, the Windows folder, no macOS permission or focus steps. The four hard lines stay. Hard line 4 becomes "this account's profile directory" because a dedicated profile's Chrome may already be open.
5. `/subscription-signin` gains an "On Windows (WSL)" subsection. The sign-in link carries `code=`, which `ndrive.sh` rightly refuses on argv, so it is typed over stdin with `typesecret`.
6. On WSL the last-resort drive is not offered: it needs a server-side browser, and none can open a Windows folder. `no-healthy-seat` hands off to the operator as before.

Success is still decided only by Instar's arbiter: completed login, matching email, a real authenticated call.

## Rollout

Each machine opts in through config (`enabled`, `navigation: agent-session`, a mode) and registry rows. Existing agents receive the skill text and the `CLAUDE.md` line by migration.

## Rollback

Set `navigation` back or `enabled: false`. A revert removes the code; a leftover `windowsUserDataDir` field is ignored.
