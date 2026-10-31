# Windows sign-in repair

<!-- bump: patch -->

## What Changed

Automatic sign-in repair now has a Windows path. On an agent in WSL with `subscriptionPool.assistedRelogin.navigation: agent-session`, the repair's helper session signs in through Windows Chrome with `ndrive.sh`. A profile records its Windows folder with `PATCH /playwright-profiles/:id` (`windowsUserDataDir`), and a profile without one shows `profile-directory-missing` in `blockers`. `/subscription-signin` gains an "On Windows (WSL)" subsection, added to existing copies by migration.

## What to Tell Your User

If your agent runs on a Windows machine, it can now repair a signed-out account by itself once that machine is set up for it. Google may still ask you for a phone tap now and then.

## Summary of New Capabilities

- Windows sign-in repair: set `assistedRelogin.navigation: agent-session` on a WSL agent, then record each profile's Windows folder.
- `PATCH /playwright-profiles/:id` with `{"windowsUserDataDir":"C:\\..."}` records a profile's Windows folder.

## Evidence

A read-only run from a background session on the Mama PC (2026-10-31) showed `ndrive.sh canfocus` and `target` answering through the bridge and PowerShell reading `%LOCALAPPDATA%`. The server answered "not configured" for sign-in repair, and sagemind-justin had an open incident with no repair. Unit, integration and e2e tests cover the new path. A live repair on the Mama PC is the final proof after release.
