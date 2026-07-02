---
slug: sentinel-reachability-eli16
companion-spec: SENTINEL-REACHABILITY-SPEC.md
date: 2026-05-24
---

# Sentinel Reachability — plain English

## What's broken

We have three "guardian" features that watch for specific kinds of stuck sessions and try to recover them: one for Anthropic's "servers are busy" throttle, one for when the API connection silently drops, and one for sessions that go quiet while they were supposed to be working.

All three were built, tested, and shipped. All three work fine in the test fixtures. **None of them recover the failure when it actually happens to you in real use.**

Here's the shape of the bug, in everyday terms. Imagine you put a smoke alarm in every room of the house. You test each one — the test button beeps. Great. But the alarms are wired to a single switch in the basement marked "send alert to phone," and that switch defaults to **off**. So when there's an actual fire, the alarms detect it, the lights flash internally, but nothing reaches your phone. From your perspective, the alarms might as well not exist.

That's exactly what happened with the rate-limit sentinel. When your interactive Claude Code window for the echo agent hit Anthropic's throttle yesterday:

- The sentinel detected the throttle string — ✓
- It scheduled the right backoff timer — ✓
- After the timer, it tried to send you a "hey, throttled, backing off, you're not dropped" note — but the function that sends that note checks "is this session bound to a Telegram topic?" first, and if the answer is no, it silently returns without doing anything.

Your interactive window isn't a Telegram-topic session. It's just a developer window where you talk to the agent directly. The check returned false. The note went nowhere. Same for the recovery nudge. So you sat watching the throttle for seven minutes with no recovery, no signal, no anything — exactly as if no sentinel was installed.

The other two sentinels (socket-disconnect and active-silence) have the same shape of bug, but for a different reason: their "send to Telegram" switch defaults to off. They detect, they log internally, you never see it.

## What's also broken — worktrees

Separate but related: when we make a "worktree" (a separate working copy of the instar source so a sub-session can do work without disturbing the main checkout), our convention says put it in agent-home so macOS can't revoke access to it mid-session.

That convention is only half-right. When git makes a worktree, the worktree's *files* go in the new location, but the worktree's *metadata* (the small `.git` folder it actually uses for every operation) stays back in the parent repo. The worktree just has a tiny pointer file that says "look in the parent's `.git/worktrees/<my-name>/` folder."

So when macOS revokes access to the parent path — which is the failure mode the convention was supposed to prevent — every git command in the worktree fails. Even though the worktree's own files are safely in agent home, the brain it depends on is back in the blocked space.

## What we're fixing

**Part A — make the sentinels actually reach you:**

1. When a sentinel can't find a Telegram topic for the session, fall back to the agent's lifeline topic (the one always-available system topic every agent has). If even that's missing, log a loud "recovery-unreachable" audit event so you can grep for it later. Never silently no-op.

2. The "send sentinel events to Telegram" switch flips to **on by default**, with consolidation so it can't spam you (one summary message per minute window, not one per event).

3. The recovery nudge gets a non-topic-prefixed injection path so it works for sessions that aren't Telegram-bound.

**Part B — make worktrees actually isolated:**

1. Instead of `git worktree add`, we `git clone` into agent home. The clone has its own real `.git/` folder, entirely in agent home. The parent path can be revoked, deleted, set on fire — the worktree keeps working.

2. Existing worktrees get a one-time migration. If they're clean, they're re-cloned automatically. If they have uncommitted changes, you get a Telegram notice telling you which ones and a single command to migrate them when you're ready.

3. New command: `instar worktree health` reports which worktrees are healthy, which have broken pointers, and which need manual migration.

**Part C — the test that would have caught all this:**

The previous tests for the sentinels passed because they asserted on internal events ("did the sentinel emit `recovered`?"). They didn't assert that a real message reached a real outbound queue.

The new test: spawn a session that is **not** bound to any Telegram topic. Plant the exact failure string in the session's terminal. Run the full server stack with default config. Assert that a message arrived at the lifeline topic — the actual user-reachable destination, not just an internal event. Same for socket-disconnect and silence sentinels.

Without this test, the recovery features are "tested" but unverified. With this test, "tested" means "actually reaches the user."

## Why this took two ships to find

The rate-limit sentinel went out as v1.2.33 with all three test tiers green. The bug-fix-evidence-bar lesson is: green tests with a topic-bound fixture don't tell you anything about non-topic-bound real-world sessions. The right evidence bar was "reproduce the live failure, then watch the fix recover it" — which I didn't do. I'm folding that into the new Tier-3 reachability test so the failure mode can't sneak past again.

## Scope

One PR, three coordinated parts. Real reproduction of each failure mode in CI. Migration entries for the config default and the existing worktrees. New CLAUDE.md template section so every agent knows what to expect.
