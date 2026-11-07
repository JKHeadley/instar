<!-- bump: patch -->

## What Changed

An owner can now give other people limited access to an agent that runs on one machine. The server side is complete: the owner's phone invites a person, chooses their role (admin, member or guest) and shares chosen conversations. Each change is a record the phone signs, kept in a log on the machine. A team phone sees only what it was given, and every route checks the person's role and the conversation.

Nothing changes for an agent until its owner sends a first invite, so existing agents keep working exactly as they did. The app screens for this are the next step, so no one can start it from the app yet.

## What to Tell Your User

Team access for one-machine agents is built on the server and waiting on its app screens. When those arrive, you will be able to invite someone from your phone and share only the conversations you choose. Some limits will apply: scheduled jobs run for you and can read messages in shared conversations; once a conversation has been shared it stays locked to that audience; and an agent that has had team members cannot add a second machine until multi-machine support is finished.

## Summary of New Capabilities

Owner-only invites, grants and role changes under `/mobile/team/`, with Face ID for turning team access off, restoring its record and requiring memory privacy. `POST /team/people/:personKey/lower` lets the agent take access away and never give it. A `team` phone role, route tiers and per-conversation checks.

## Evidence

A status table runs owner, MSP, admin, member, guest and removed phones against every route in the device allowlist, with team access never on, on, and after turning off. The paths are generated from the allowlist, so a new route is covered automatically. An end-to-end test on a real AgentServer runs the whole journey: pair the owner, invite a member, share one conversation, pair the member, read and send there, be refused elsewhere, and lose access on removal. Spec: `docs/specs/team-roles-and-access.md`.
