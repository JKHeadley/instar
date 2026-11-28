# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

When the Windows Remote Desktop companion fails to install at a WSL agent's start, the recorded reason is now specific. Before, almost every failure read "preflight / installer-process-failed", partly because the patterns looked for "spawn <file> ENOENT" while the installer's errors read "spawnSync <file> ENOENT". New codes name a missing or slow cmd.exe, wslpath or PowerShell, broken WSL interop, a module-load failure, a timeout (including flock's 130-second kill), output overflow, a missing flock, and a busy install lock.

## What to Tell Your User

If Remote Desktop is off on a Windows machine, I can now see why the helper failed to install, instead of a generic failure, so it can be fixed directly.

## Summary of New Capabilities

Specific failure codes in the desktop diagnostics for a failed Windows companion install. The installer itself is unchanged.

## Evidence

The Mama PC recorded the catch-all code at every start on 27 Nov 2026. Real Node 24 execFileSync error shapes were checked by hand. Ten unit tests across the two files that use this module pass, including the nested flock layout as Node builds it.
