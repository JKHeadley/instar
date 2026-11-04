# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Memory privacy is now off unless an owner sets `memoryPrivacy.enabled` to true. An update will not restrict an agent, refuse a message, or limit what a session can read. New agents start with it off too, until a backup machine can be trusted to keep the setting. Sessions left inside the privacy boundary are ended at startup, and the next message starts an ordinary one.

## What to Tell Your User

Memory privacy is now off on me unless you ask for it, so I'll keep working the way I always have. If several people use me, what they tell me is not kept separate until you turn it on.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Opt in to memory privacy | Set `memoryPrivacy.enabled` to true in `.instar/config.json` on every machine, then restart |

## Evidence

Reported 2026-11-04: the feature refused an owner on their own agent and blocked another agent's reads. On a machine with no setting, first boot after an update wired privacy from config loaded before the migration ran, so the default itself had to change, not only the migration.
