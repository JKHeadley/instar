---
title: Wedge-recovery message loss — terminally abandon + notify, don't silently drop or re-loop
status: converged
author: echo
created: 2026-06-15
eli16-overview: "wedge-recovery-message-loss.eli16.md"
review-convergence: self-converged (autonomous run; exactly-once-ledger surface — careful state-model review applied)
approved: true
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
relates-to: CMT-1563
---

# Wedge-recovery message loss — terminal abandon + loss notice

## Problem (grounded in live evidence, 2026-06-15)

`stuckMessageRecovery.recoverStuckMessages` re-runs inbound events stranded in `processing`
(a holder crashed/was fenced mid-turn). When an entry's re-run budget is exhausted
(`attempts >= maxReplayAttempts`, default 3), the give-up branch did `skipped++; continue` —
it neither terminally resolved the entry nor told the user. Two failures, both observed live:

1. **Silent message loss.** A user message that genuinely never got a reply is abandoned with
   NO notice — the user is left waiting forever. This is exactly the 2026-06-15 report
   ("wedge-recovery drops messages... they shouldn't be given-up-on").
2. **A give-up log-loop.** The entry stays in `processing`, so `reclaimStuck` re-selects it on
   EVERY recovery cycle → `stuck-recovery: giving up on telegram:21487:990487 after 3 attempts`
   fired every ~10 min for hours on the same 3 entries (live `logs/server.log`, 19:07→20:11).

## Goal

An exhausted stuck entry must be **terminally resolved** (stop the re-loop) AND **surfaced** so the
abandonment is never silent — while preserving the exactly-once guarantees (no false reply-evidence,
no double-act, no loss of a still-recoverable entry).

## Design

Add a terminal `abandoned` state to `MessageProcessingLedger`:

- **`markAbandoned(dedupeKey, epoch)`** — `processing → abandoned`, sets `abandoned_at`, leaves
  `reply_committed_at` NULL (so it can NEVER masquerade as a real reply in
  `hasReplyCommittedForTopicSince` — the bug a `cursor_advanced` shortcut would cause). No-op unless
  still `processing`.
- `abandoned` is terminal: `reclaimStuck` (selects `processing` only) skips it → the log-loop ends;
  `beginProcessing` refuses it → never revived; `isActedOn` includes it → a provider redelivery of
  the SAME event is dropped (a genuine resend arrives with a fresh dedupeKey).
- `LedgerState`, `LedgerEntry.abandonedAt`, schema column `abandoned_at` (idempotent ALTER — no
  PostUpdateMigrator step, per the ledger's self-migrating contract).

`recoverStuckMessages`: the give-up branch calls `markAbandoned` and pushes the entry to a new
`result.abandoned: Array<{topic, dedupeKey}>`. `server.ts` emits ONE per-topic loss notice —
`"I didn't get to N message(s) you sent earlier … resend anything still needed."` (the existing
durable-inbound-queue loss-notice pattern, targeted to the topic). Fires exactly once per entry
(markAbandoned moves it out of `processing`).

## Non-goals

- Re-running an abandoned entry automatically (the budget exists precisely to stop the storm); a
  genuine resend (fresh dedupeKey) is the recovery path, prompted by the notice.
- Cross-machine transcript/continuation carry (that is gap #1, a separate spec).

## Testing (3-tier)

- **Unit (ledger):** `markAbandoned` → state `abandoned`, `abandonedAt` set, `replyCommittedAt`
  NULL, `isActedOn` true, `beginProcessing` refuses, `hasReplyCommittedForTopicSince` still false,
  `reclaimStuck` skips it; no-op when not `processing`.
- **Unit (recovery):** an exhausted entry is abandoned + surfaced in `result.abandoned`; a
  subsequent pass does NOT re-select or re-surface it (the loop is gone); existing re-run /
  already-handled / sender-preservation paths unchanged. 30/30 ledger+recovery unit tests green.
- **Wiring:** `server.ts` emits the per-topic notice from `result.abandoned` via `notify(...)`.

## Risk / rollback

Exactly-once ledger is the highest-risk subsystem. Fail-safe: `markAbandoned` only ever acts on an
ALREADY-exhausted `processing` entry; it cannot affect an in-flight or recoverable entry, and it
never sets reply-evidence. The new terminal state is additive (free-TEXT `state` column, no CHECK
constraint). No flag — this is a correctness fix to a live loss + log-loop, not a dark feature.
