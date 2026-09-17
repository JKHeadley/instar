# Resume Follows the Account — Plain-English Overview

> The one-line version: when an agent restarts a Telegram or Slack conversation under a different Claude login, the conversation now comes along, and a restart that crashes is noticed within seconds instead of looping forever.

## The problem in one breath

An agent can own several Claude subscriptions and spread its work across them. Each subscription keeps its own private folder of past conversations. On 2026-09-16, Luna's "GCI MCP servers" topic had been running under one subscription that hit its weekly limit, so the next restart used a different one. That subscription's folder didn't contain the conversation, so Claude quit in 16 seconds. Two more bugs turned one failure into a permanent loop: instar couldn't tell Claude had quit, and a background job kept replacing the topic's saved conversation pointer with a random internal file. Every message Justin sent got "Session respawned" followed by silence.

## What already exists

- **The subscription pool** picks which Claude login a session runs under, based on usage left. It never looked at where the conversation is stored.
- **A copy helper for deliberate account swaps** copied the conversation to the new login, but only on that one path, and it could pick an old copy.
- **A "reopen failed, start fresh" safety net** existed but only fired when the terminal window disappeared. Instar keeps a crashed window open, so it never fired.
- **The saved conversation pointer** was refreshed every minute and, when unsure, guessed the most recently changed file, which is usually one of the agent's own background checks.

## What this adds

Before a Telegram or Slack conversation reopens under a Claude login, instar puts the newest copy of that conversation into that login's folder. It never deletes anything: an older copy that is an earlier part of the newer one is replaced, and a copy that split off into its own version is kept under a different name. If there's no copy anywhere, the conversation starts fresh from the topic's recent messages, and Claude is told plainly that its earlier conversation couldn't be reopened.

Two smaller fixes close the loop:

- **Crashed means crashed.** Instar now checks whether the program in the window actually exited. A crashed reopen is caught within about two seconds and gets the existing one fresh retry, on the same kind of session, with the crash output written to the log.
- **The pointer stops guessing.** The background job only saves a conversation Claude itself reported. Old guessed pointers are ignored, and internal one-off check files are never reopened as a conversation.

## The safeguards

**Nothing is deleted.** Copies are only added, replaced when provably contained in the newer one, or set aside.

**It can't loop.** A reopen that crashes gets exactly one fresh retry, which already existed.

**It stays small.** No new background jobs or settings beyond one off switch. Checks replace existing ones rather than adding more.

**One off switch.** `sessions.resumeFollowsAccount.enabled: false` in the agent's config restores the old behaviour for the copy and crash checks, after a restart.

## What ships when

One change with unit, integration and real-tmux tests. It ships to every agent in the next release because it fixes something broken. On Luna, the check is that her five saved topics reopen on the next message with no "No conversation found".

## What you actually need to decide

Nothing further. You asked for the permanent fix with an 80/20 scope; this is that scope.
