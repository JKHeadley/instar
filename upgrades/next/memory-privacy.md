# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

When an agent serves more than one person, one person's remembered facts could reach another. Each conversation now has an audience set by its place: a private chat serves one person, and a channel or group serves everyone who can read it.

Each audience has its own memory folder. Sessions outside the owner's private chats run in an operating system sandbox and hold a limited key that the server refuses everywhere except a short list. If the sandbox cannot start, the agent sends a fixed reply and does not run unprotected.

A Slack reply now goes to the thread its message came from.

## What to Tell Your User

If you are the only person using me, nothing changes in our private chats. In a channel with other people, I now keep your private memory out, so I may know less there. If several people use me, each person's memory stays theirs.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Memory privacy status | `GET /memory-privacy` |
| Name people who share memory freely | `memoryPrivacy.sharedMemoryPeople` in `.instar/config.json` |
| Switch it off | `memoryPrivacy.enabled: false` in `.instar/config.json` |

## Evidence

Tested with real sessions on macOS and Ubuntu 24.04. On Ubuntu 24.04 the sandbox needs a one-time AppArmor profile; the agent installs it if `sudo -n` works.
