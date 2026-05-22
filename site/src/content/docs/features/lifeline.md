---
title: Lifeline
description: Persistent supervisor that keeps your agent alive.
---

The Lifeline is a persistent Telegram connection that supervises your agent's server. It runs outside the server process, so it can detect crashes and recover automatically.

## What It Does

- **Auto-recovery** -- If the server goes down, the Lifeline restarts it
- **Message queuing** -- Messages received during downtime are queued and delivered when the server comes back
- **First-boot greeting** -- Your agent greets you on Telegram in its own voice the first time it starts
- **Lifeline topic** -- Created during setup with a green icon, dedicated to agent health

## Commands

```bash
instar lifeline start    # Start lifeline (supervises server, queues messages)
instar lifeline stop     # Stop lifeline and server
instar lifeline status   # Check lifeline health
```

## Why a Separate Process?

The server runs inside tmux and can be killed, crash, or hit resource limits. The Lifeline runs as a separate Node.js process (or via `instar autostart` as a system service) that monitors the server and brings it back if it goes down.

Without the Lifeline, a server crash means silence until you notice. With it, the agent self-heals and queues messages so nothing is lost.

## Version-skew handling (v1.1.3+)

A subtle failure mode: the server auto-updates to a new version, but the lifeline process keeps running the old binary. The new server's `/internal/telegram-forward` endpoint speaks a different protocol version than the old lifeline expects, and every forwarded message gets rejected with HTTP 426. The old lifeline's drop-after-3-failures policy then silently drops user messages.

This actually happened on 2026-05-19 → 2026-05-20: a 21-hour silent ingress drop in production. The fix (PR #284, shipped in v1.1.3) closed the failure class with five interlocking pieces:

1. **Version-skew bucket bypasses cooldown.** A hard incompatibility cannot be cured by waiting, so the rate limiter no longer wedges restart attempts during version skew. Daily caps and storm detection remain as backstops.
2. **Replay-loop drop policy is gated on a version-skew episode flag.** When `forwardToServer` raises `ForwardVersionSkewError`, the lifeline sets the episode flag and re-queues without incrementing the failure counter.
3. **User-visible alert.** A single Telegram message tells you "ingress paused: version skew detected, your messages are not lost" so you know what's happening.
4. **Restart with the new binary.** The lifeline detects the skew, restarts itself to pick up the new version, and the episode clears on the next successful forward.
5. **Heartbeat-based liveness detection** rather than process polling — the lifeline isn't "alive" just because the PID exists; it's alive when it's still forwarding successfully.

The version-skew path is silent under normal operation. You'll only see the user-visible alert if a real skew episode occurs.

## Lock acquisition and recovery

The lifeline holds a file lock to prevent multiple instances racing. On startup, the lock acquisition code distinguishes three states:

- **Lock held by live process** — refuse to start, exit cleanly
- **Lock held by stopped/zombie process** — clean up the dead PID and acquire
- **Lock held by wedged sleeping process** (over 5 minutes in S state after SIGTERM) — escalate to SIGKILL via the `LifelineHealthWatchdog` and acquire after the process exits

This auto-recovery means a crashed lifeline doesn't require manual cleanup to restart.

## Rate limiting and restart storm detection

The lifeline tracks restarts in per-minute and per-day buckets. If restarts exceed the per-minute cap, it backs off; if they exceed the daily cap (default 3 per 24 h, excluding version-skew episodes), it stops attempting and waits for human intervention. The `isRestartStorm()` check flags coordinated multi-failure patterns so the lifeline doesn't thrash through a recoverable upstream issue.

## Per-channel lifelines

Telegram is the primary lifeline channel, but the same supervisor pattern runs for Slack (`SlackLifeline`) where configured. Each channel has its own message queue, its own restart accounting, and its own first-boot greeting flow.
