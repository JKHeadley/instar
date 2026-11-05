# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

When private memory can't run, the agent now reports the real reason instead of always saying the platform has no sandbox. The most common real reason found so far is an agent set to use a Claude Code older than private memory needs. Memory privacy is opt-in, so this applies to agents whose owner turned it on. The owner now hears the reason privately, with a link to a page that gives the solution. When a working Claude Code is on the machine, that page can fix it in one click. Everyone else still gets the same fixed reply.

## What to Tell Your User

If you ever see "I can't reply here yet", I'll now send you the reason in a private message, with a link to the solution.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| The real cause in status | `GET /memory-privacy` now includes `blocker` and `fix` |
| Owner solution link | Sent privately to the verified owner; needs a tunnel so it opens on a phone |

## Evidence

Reported 2026-11-04: an owner was refused in their own Slack channel on a Mac agent set to Claude Code 2.1.300, below the 2.1.316 floor. The status said the platform had no supported sandbox, but the Mac sandbox worked. Changing only that Claude path made the agent ready.
