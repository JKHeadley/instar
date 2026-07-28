# Reaper stale-commitment override — ELI16

> The one-line version: idle sessions never got cleaned up because each one had a "promise" (commitment) left open on it, and the safety rule "never kill a session with an open promise" protected it forever — even after the user hadn't touched it in days. Now an open promise only protects a session while it's still recently active; after a day of silence the promise counts as abandoned and the session can be reaped.

## The problem (found 2026-06-06 during a load-average-30 overload)

The machine kept getting overloaded. Root: dozens of Claude sessions, some 26+ hours old, each holding a heavy MCP server stack, never cleaned up. Instar HAS an idle-session reaper — but a 15-minute dry-run showed it would reap NOTHING. The reason breakdown across 26 sessions: **19 were kept by "open-commitment"**. Almost every session had a commitment (a tracked promise to the user) still marked open, and the reaper's safety rule is "never reap a session with an open commitment." So a commitment left open for days on a silent session pinned that session alive forever.

That guard is correct in spirit (don't kill a session mid-promise) but too blunt: a promise sitting open on a session the user hasn't messaged in a day is itself abandoned — it shouldn't keep a dead session running.

## What this changes

One guard, made activity-aware. The open-commitment KEEP-guard now protects a session **only if a user message arrived within a staleness window** (default 24h — the operator's "no message today → reap" rule). Past that window the commitment is treated as stale and no longer vetoes reaping; the session falls through to the normal activeness checks (active processes, recent output, etc.) like any other.

- New option `staleCommitmentWindowMs` on `ReapGuard` (default 24h; `Infinity` restores the old always-protect behavior).
- New config `monitoring.sessionReaper.staleCommitmentWindowMinutes` (default 1440).
- Threaded through `SessionReaper` → `ReapGuard`; the terminate-time authority guard picks up the 24h default too.

## Why it's safe

- It only ever makes MORE sessions reap-eligible, and ONLY ones that are both (a) commitment-pinned AND (b) untouched by the user for 24h — i.e. genuinely abandoned. Every active session, every session with recent activity, and every session with a recent commitment stays exactly as protected as before.
- It changes nothing else in the guard chain — recent-user-message, active-process, active-subagent, protected-set, pending-injection, etc. all still fire first/after exactly as before.
- A session must STILL clear all the other activeness guards after this to actually be reaped; this only removes the stale-commitment veto.
- Default 24h is conservative; set `Infinity` to disable entirely.

## Honest scope

This unblocks the reaper from doing its job; it's paired with enabling the reaper + MCP reaper + sleep controller (which ship opt-in and were off fleet-wide). Validated with the same dry-run that found the problem. Does not by itself reduce a live count — it changes which sessions become eligible; the reaper (in dry-run first, then live) acts on them.

## Evidence

`tests/unit/reap-guard.test.ts`: both sides of the new boundary — stale commitment (no message in window) falls through to reap-eligible; fresh commitment (message within window) still keeps as "open-commitment"; a custom window is honored; `Infinity` restores always-protect. Plus the existing open-commitment case updated to the window-aware mock. 19/19 green. `tsc --noEmit` clean.
