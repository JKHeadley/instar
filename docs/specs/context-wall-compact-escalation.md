---
title: Context-Wall Recovery Escalation — press /compact before the destructive respawn
date: 2026-06-06
author: echo
status: shipped
review-convergence: incident-2026-06-06-compaction-recovery
companion-spec: honest-turn-receipts.md
---

# Spec — Context-Wall Recovery Escalation

**Date:** 2026-06-06 · **Author:** echo · **Status:** shipped (default-on when wired, signal-gated)

## Triggering report

The user: "still sometimes having trouble recovering from compaction." Evidence
— a session pane pinned at "Context limit reached · /compact or /clear to
continue" with "100% context used", repeating on every message; and overnight a
topic received "Session hit \"conversation too long\" and can't continue. Send a
new message…" ~13 times.

## What was already fixed (grounding)

The overnight flood was OLDER-version behavior. The deployed version (1.3.380)
already had, from same-day parallel work:
- **False-death suppression** (SessionMonitor): a session at 100% context that
  is still *producing work* (active child processes) is deferred and the user
  notification suppressed — "2026-06-06 flood: 68 detections / 29 deferrals / 0
  false-deaths".
- **#935** — sentinel recovery verification survives conversation-UUID rotation.

## The residual gap this closes

Grounded in the logs: **zero** real context-exhaustion recoveries had ever
fired — every detection was deferred (working session). And when recovery DOES
fire (a genuinely idle session stuck at the wall), `SessionRecovery
.recoverFromContextExhaustion` only ever did ONE thing: kill the session and
respawn FRESH (no `--resume`), explicitly LOSING the conversation ("You are NOT
resuming the old conversation"). **Nothing ever pressed `/compact`** — the exact
escalation the wall asks for, and the one that would PRESERVE the conversation.

## Design — a two-rung escalation ladder

`recoverFromContextExhaustion` now tries the non-destructive rung first:

**Rung 1 — `/compact` (preserves the conversation).** Gated to a GENUINELY idle
session (`!hasActiveProcesses` — a working session at 100% is handled by the
existing kill-defer, never compacted out from under its work). The injected
`attemptCompaction(sessionName)` dep presses `/compact` and polls the live tmux
tail (up to 30s): if the context-wall signature clears (`detectContextExhaustion`
no longer matches) → recovered, conversation intact. If compaction itself errors
("Error during compaction: Conversation too long") or times out → fall through.

**Rung 2 — kill + fresh respawn (conversation lost).** The pre-existing
behavior, now reached only when `/compact` is unavailable, declined (active
children), or could not clear the wall. Never worse than before.

The dep is OPTIONAL: absent ⇒ the rung is skipped and recovery behaves exactly
as before (pure back-compat).

## Signal-vs-authority

The escalation adds a bounded, gated recovery ACTION (pressing `/compact`),
strictly LESS destructive than the existing kill+respawn it precedes. It is
gated by the same `hasActiveProcesses` work-check that guards the kill, and by
the existing attempt/cooldown limits (`shouldAttempt`). No new user-facing
authority; failure degrades to the prior path.

## Files

- `src/monitoring/SessionRecovery.ts` — `attemptCompaction?` dep + rung-1 in
  `recoverFromContextExhaustion`.
- `src/commands/server.ts` — wires `attemptCompaction` (injectMessage('/compact')
  + verify via `detectContextExhaustion`); imports `detectContextExhaustion`.
- `src/core/PostUpdateMigrator.ts` — "Context-wall recovery escalation" CLAUDE.md note.

## Tests

- **unit** `context-exhaustion-recovery.test.ts` — /compact clears → recovered
  WITHOUT kill/respawn (conversation preserved); /compact fails → falls through
  to fresh respawn; working session (active children) → deferred, never
  compacted; no dep → straight to respawn (back-compat); compaction throwing →
  non-fatal fall-through. Plus a server.ts wiring guard (the dep presses
  /compact + verifies; import present).
- **unit** `PostUpdateMigrator-contextWallEscalation.test.ts` — note ships fresh
  + patches an existing Honest-standby section + idempotent.
