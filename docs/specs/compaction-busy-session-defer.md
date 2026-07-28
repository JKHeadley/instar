---
title: Compaction recovery — defer re-inject while the session is actively working
status: approved
author: echo
date: 2026-05-29
review-convergence: "2026-05-30T00:42:36.090Z"
review-iterations: 2
review-completed-at: "2026-05-30T00:42:36.090Z"
review-report: "docs/specs/reports/compaction-busy-session-defer-convergence.md"
approved: true
approved-note: "Fast-tracked by echo as an urgent fleet-wide relay-UX bug (the false 'session is restarting' loop Justin reported, topic 15160). Bounded, additive, safety-improving guard with full 3-tier coverage; convergence panel constrained to self-review. Disclosed in the convergence report and to Justin."
---

# Compaction recovery — busy-session defer guard

## Problem

A user sends a Telegram message and instead of an answer gets a "Session
respawned / starting up" notice; the message never lands; they fall back to the
dashboard to reach the live session. From the user's seat: *"it says the session
is restarting EVEN THOUGH I KNOW the session is still alive, and my message never
goes through."*

Verified root cause (read from the running code + `logs/server.log` on Echo,
2026-05-29):

`CompactionSentinel` recovers a compacted session by injecting a re-orient
prompt and then watching the session's Claude Code JSONL transcript for growth
within `verifyWindowMs` (25s). If it sees no growth it concludes "stuck" and
**re-injects** — up to `maxInjectAttempts`. But a long extended-think on a large
context (very common right after resuming a near-full transcript) emits **nothing
to the JSONL until the turn lands**, so a perfectly-alive, hard-working session
reads as "stuck." Each re-inject stacks another full recovery bootstrap into the
input on top of the user's real message, so the real message is buried and the
user sees repeated "restarting" narration instead of a reply.

Observed on Echo: three identical re-injects ~26s apart (00:14:43 / 00:15:09 /
00:15:35 UTC) against a live session — each writing a fresh
`/tmp/instar-compaction-resume/*` prompt — i.e. the loop the user reported.

A second, smaller contributor in the same family: `SessionManager.verifyInjection`
fires a recovery Enter whenever the injected marker is still at the `❯` prompt —
which is *also* the normal state of a busy session with correctly-queued input —
producing the noisy `Injection stuck — Auto-recovering` warnings on every inbound
to a working session.

## What already exists

- `CompactionSentinel` (lifecycle: detect → inject → verify-jsonl-growth → retry
  → finalize; dedupe across triggers; zombie-kill veto while recovery is in
  flight). Fully dependency-injected (`recoverFn`, timers, `now`).
- `SessionManager.hasActiveProcesses(session)` — true when a non-baseline child
  process (a tool) is running under the pane.
- `StuckInputSentinel.isPaneActivelyWorking(pane)` + its `ACTIVITY_INDICATORS`
  (`esc to interrupt`, `tokens · esc`, `ctrl+t to hide tasks`) — the canonical
  "Claude is mid-turn" footer tell. The footer is present ONLY while a turn is in
  flight, so it does not false-fire on a dead/idle pane.

## The change

Teach the recovery surfaces to recognize an actively-working session and refuse
to take a disruptive action against it — reusing the existing canonical signal.

1. **`src/core/claudeActivityIndicators.ts` (new)** — single source of truth:
   `CLAUDE_WORKING_INDICATORS` + a pure `paneShowsClaudeWorking(pane)`. Footer
   hints only (deliberately NOT spinner glyphs, which can persist in a dead
   pane's last frame). `StuckInputSentinel` now imports its `ACTIVITY_INDICATORS`
   from here so the surfaces cannot drift.

2. **`SessionManager`** — `paneShowsActiveWork(pane)` (pure) and
   `isSessionActivelyWorking(session)` = footer present in a fresh capture OR a
   live non-baseline child process. Never throws. Also: `verifyInjection` skips
   the recovery Enter (but keeps polling) when the pane shows active work — the
   input is correctly queued and submits when the turn ends.

3. **`CompactionSentinel`** — new optional dep `isActivelyWorking(session)` and
   config `maxWorkingDefers` (default 10). Before any inject (first attempt or a
   retry) and at the verify boundary, if the session is actively working and the
   defer budget is not exhausted, the sentinel **defers**: it waits one more
   `verifyWindowMs` WITHOUT re-injecting (status `deferring`, emits
   `compaction:deferred`), and re-checks. JSONL growth during a defer still
   finalizes as `recovered` with zero injects. The cap means a genuinely-hung
   "working" footer still gets a forced inject eventually.

4. **`server.ts`** — wire `isActivelyWorking: s => sessionManager.isSessionActivelyWorking(s)`.

## Why it's safe to default ON (no opt-in flag)

This change ONLY alters behavior for a session that is *actively working* — the
exact case the old code must not trample. A genuinely idle-at-prompt session, or
a wedged session that fast-fails every turn, shows no footer and runs no child
process → `isSessionActivelyWorking` returns false → recovery proceeds EXACTLY as
before. So the fix removes a false-positive harm and cannot starve a real
recovery. The escape hatch is `maxWorkingDefers: 0` (restores pre-fix behavior);
the dep is optional, so an un-wired sentinel is also unchanged.

## Blast radius / migration

Pure `src/` logic. No agent-installed files (no `.claude/settings.json` hooks,
no `.instar/config.json` defaults, no CLAUDE.md template, no hook scripts, no
skills). Every agent receives it through the normal dist update — no
`PostUpdateMigrator` entry required.

## Testing (all three tiers)

- **Unit**: `CompactionSentinel.test.ts` (+busy-defer describe: defer-while-
  working, inject-when-idle, recover-without-inject-on-growth, defer cap forces
  inject, `maxWorkingDefers:0` disables, no-dep backward-compat),
  `claudeActivityIndicators.test.ts`, `session-active-work.test.ts`.
- **Integration**: `compaction-busy-defer-wiring.test.ts` — REAL
  `CompactionSentinel` × REAL `SessionManager.isSessionActivelyWorking` (the
  exact server wiring): defers while working, injects when idle, defers on a live
  child process.
- **E2E**: `compaction-busy-defer-lifecycle.test.ts` — real-disk/real-timers
  micro-lifecycle (never injects while working, recovers when JSONL grows) +
  WIRED-into-server.ts dead-code guard.
