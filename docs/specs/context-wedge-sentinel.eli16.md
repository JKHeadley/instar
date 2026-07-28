# ContextWedgeSentinel — Plain-English Overview

> The one-line version: when a session gets permanently stuck on a specific "can't edit the thinking block" error and dies while still looking busy, we now notice it and (optionally) restart it cleanly.

## The problem in one breath

A session got permanently stuck and Justin only saw "standby" replies while the real session failed instantly on every message. The cause: when a tool call gets cancelled inside a *batch* of parallel tool calls while the model is using extended thinking, the harness corrupts the thinking part of the last turn — and after that, the AI service rejects every attempt to continue with a `400 … thinking blocks … cannot be modified` error. The session is dead but keeps printing the error, so none of our existing "is a session stuck?" watchers caught it.

## What already exists

- **The silently-stopped sentinels** — two existing watchers. One notices when a session goes *quiet* (stops printing anything); the other notices when a session loses its connection. Both try a gentle "nudge" (press Enter) to wake it.
- **SessionRefresh** — the existing machinery that kills a session and respawns it while *keeping* the conversation (it resumes from where it left off).
- **The audit log** — every watcher writes what it sees to a `sentinel-events.jsonl` file; by default the user never gets pinged.
- **The Graduated Feature Rollout track** — the system that lets a risky feature ship "off," watches whether it proves itself, and nags toward turning it on for everyone.

## What this adds

A third watcher — the **ContextWedgeSentinel** — that recognizes this exact "stuck on a thinking-block error" death and can recover from it. The crucial twist: a gentle nudge can't fix this one (re-trying just re-sends the broken turn and hits the same error), so recovery means a *fresh* restart that throws away the corrupted conversation instead of resuming it.

- Noticing the problem and writing it to the audit log is **on by default** — it's harmless, it never touches a session.
- Actually restarting a stuck session is **off by default** and opt-in, because restarting is destructive.

## The new pieces

- **ContextWedgeSentinel** — watches each session for the thinking-block error showing up as the *live tail* of the screen, waits ~45 seconds to confirm the session really is stuck (not just mentioning the error in passing), then either logs it, escalates it, or restarts it depending on the setting. It is NOT allowed to restart a session on its own unless an operator turned that on.
- **SessionRefresh "fresh mode"** — a new option that, after killing the stuck session, deletes the saved "resume here" pointer so the next message starts a brand-new conversation. Without this, the restart would just reload the corrupted conversation and get stuck all over again — an endless loop.

## The safeguards

**Prevents falsely killing a healthy session.** A session merely *talking about* this bug (like the one writing this) won't be flagged: the error has to be the live bottom-of-screen tail AND still be there 45 seconds later with no progress. And the destructive restart is opt-in — by default the worst that happens is a log entry and (if enabled) a heads-up.

**Prevents the endless re-stuck loop.** The fresh restart clears the saved resume pointer, so the new session can't reload the broken conversation.

**Prevents accidental fleet-wide surprises.** Restarting ships "off." It rides the rollout track, which nags toward "on" only after it proves itself, and turning it on is a deliberate human change.

## What ships when

It all ships in one change, but in a safe order of *behavior*: detection + logging are live immediately for everyone (harmless); the automatic restart is dark and opt-in. Echo turns the restart on for itself first to dogfood it. Only after it proves itself over a week (several real recoveries, zero false restarts) does it get promoted toward on-by-default for everyone.

## What you actually need to decide

You already approved the design — the only open question is whether you want the automatic restart to default **on** fleet-wide eventually (yes, via the rollout track) or stay opt-in forever.
