---
title: Agent-owned memory
description: An agent's Claude Code memory belongs to the agent, never to whichever subscription login a session runs under.
---

Instar can run an agent's Claude Code sessions under several subscription logins (the subscription pool, follow-me, auto-swap, resume). Each login has its own config home, such as `~/.claude` or `~/.claude-followme-<account>`. Claude Code keeps its auto-memory inside that config home, at `<config home>/projects/<project key>/memory/`. Left alone, every login grows its own separate slice of the agent's memory, and a session moved to another login forgets what the others learned.

The rule is simple: **logins hold tokens and quota, never data.** Credentials and quota state stay per login. That is the one thing a login is for.

## How it works

`AgentOwnedMemory` (`src/core/AgentOwnedMemory.ts`) makes `<config home>/projects/<agent key>/memory` a symlink to one folder the agent owns: `.instar/agent-memory/` inside the agent home. The project key follows Claude Code's own rule: the canonical git root, with every non-alphanumeric character turned into `-`. A git worktree resolves to its main checkout, so worktree sessions share the agent's memory too.

The link is made:

- **before every Claude Code session starts**, in every SessionManager spawn lane (fail-open: an error is logged and the session starts as before);
- **when a new login finishes enrolling**, through the EnrollmentWizard;
- **once for every existing agent on update**, through `PostUpdateMigrator`, across every `~/.claude*` home on the machine.

## Safe migration

If a login already holds a real memory folder, it is merged into the agent's folder before the link is made. Nothing is ever deleted.

- Files are unioned. When two copies differ, the newer one wins and the older one is kept in `_superseded/`.
- The `MEMORY.md` indexes are merged by linked filename. The previous index is kept in `_superseded/` too.
- The old folder is renamed `memory.pre-shared`, or a timestamped name if that name is taken.
- A link that is already correct is left alone, so running it again changes nothing.

## What it never touches

- Memory for **other projects** the agent works in. Those folders may belong to another agent on the same machine, or to a person running `claude` there.
- A memory link **someone else placed** that points outside the agent's home.
- A login config home that does not exist. It never creates one.
- Real logins, when the agent itself lives in a temporary folder (test fixtures, throwaway deploys).

## Not yet covered

Conversation transcripts (`projects/<key>/*.jsonl`) are still stored per login. The resume path copies a conversation into the new login when a session moves (see [Account Follow-Me](/features/account-follow-me/)). Making transcripts agent-owned as well is tracked as a follow-up.
