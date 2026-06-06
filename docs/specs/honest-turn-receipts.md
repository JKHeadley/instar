---
title: Honest Turn-Receipts — the standby tells the truth about why a turn failed
date: 2026-06-06
author: echo
status: shipped
review-convergence: incidents-2026-06-04-to-06-05
companion-spec: context-wedge-sentinel.md
---

# Spec — Honest Turn-Receipts

**Date:** 2026-06-06 · **Author:** echo · **Status:** shipped (default-on, signal-only)

## Triggering incidents (three in two days, one symptom)

The user sends a message; it is delivered and injected; the relay truthfully
shows "✓ Delivered" and the standby system shows "🔭 actively working" — but
the session never replies. The user stares at receipts and finds out by
screenshot. Three distinct root causes, all the same symptom:

1. **Rate-limit stall** (2026-06-04): a session hit the Claude usage limit and
   answered every injected message with "You've hit your session limit · resets
   10:30pm". Alive, emitting output, never replying.
2. **AUP-rejection wedge** (2026-06-05): the transcript tripped the API's Usage
   Policy classifier; every turn was rejected. Alive, emitting output.
3. **Context-wedge / context-too-long**: a corrupted-thinking-block 400 or an
   exhausted context window — same shape.

The standby's tier-3 assessment classified all of these as **"working"**,
because the test was "does the session have a live child process?" — and a
rate-limited or wedged session DOES (the `claude`/`codex` process is alive,
just failing every turn). The live process made the standby confidently lie.

Separately, the user flagged that "conversation too long" standby messages
"come up often but almost always don't affect the conversation." Root: the
context-exhaustion detector matched that phrase ANYWHERE in the snapshot, so a
stale mention scrolled far up in the buffer (after the session had already
recovered) fired it as noise.

Both are the same bug: **dishonest classification from the tmux pane.**

## Design

A pure, tail-gated classifier (`src/monitoring/StuckSignatureClassifier.ts`)
answers one honest question: *is this live session actually able to reply, or
is it failing every turn for a known reason?*

`classifyStuckSignature(capture)` returns `{ kind, message, detail? }` or null:

| kind | signature (tail-gated) | honest message | assessment |
|------|------------------------|----------------|------------|
| `rate-limited` | "You've hit your … limit", "limit · resets …" | "I've hit the usage limit (resets …) — I'll pick back up automatically" | waiting (self-clears) |
| `policy-wedge` | AUP-rejection loop (reuses `classifyWedgeTail`) | "stuck on a content-policy error — resend your last message" | dead (fresh session) |
| `context-wedge` | thinking-block 400 (reuses `classifyWedgeTail`) | "hit a stuck-context error — resend your last message" | dead (fresh session) |
| `context-too-long` | "conversation too long" as the LIVE tail | "conversation got too long — starting fresh, resend" | dead (after recovery attempt) |

Two rules carried from the ContextWedgeSentinel work:

1. **TAIL-GATED.** The signature must be the live tail (last ~12 non-empty
   lines), not merely present in scrollback. This is the discriminator between
   a real current block and a stale mention — and the fix for the "conversation
   too long" noise. Prose that merely *mentions* a limit ("when you hit your
   usage limit, the session pauses") does not match: the rate-limit patterns
   require the stative/blocking form ("you've hit", "limit reached", "limit ·
   resets"), not conditional prose.
2. **SIGNAL-ONLY.** The classifier returns an honest answer; it never kills,
   blocks, or recovers. Recovery stays with the sentinels.

### Wiring (PresenceProxy.fireTier3)

The classifier runs AFTER the existing quota-exhaustion check (which already
owns the bare usage-limit form) and BEFORE the process-tree "working"
assessment — exactly the spot where a live process would otherwise force
"working". When it matches:

- **Deference:** if a recovery sentinel already owns this session's recovery
  (`isStuckRecoveryActive`, wired to the composed wedge recovery checker), the
  standby stays SILENT — the sentinel is already messaging, the user hears one
  voice.
- **context-too-long** attempts the existing `recoverContextExhaustion` first;
  only if unavailable/failed does it surface the honest "start fresh" message.
- Otherwise it sends `🔭 <honest message>` and sets the tier-3 assessment to
  `waiting` (rate-limit self-clears) or `dead` (needs a fresh session).

## Signal-vs-authority

Pure detector + honest messaging. No new blocking authority; recovery is
unchanged (still the sentinels'). The deference callback makes the change a
NET REDUCTION in messaging authority (the standby now yields to an owning
sentinel where before it could double-speak).

## Files

- `src/monitoring/StuckSignatureClassifier.ts` (new) — classifier.
- `src/monitoring/PresenceProxy.ts` — `isStuckRecoveryActive` config + the
  honest-classification block in `fireTier3` (replaces the un-tail-gated
  context-exhaustion block, preserving its recovery path).
- `src/commands/server.ts` — wires `isStuckRecoveryActive` to `wedgeRecoveryActive`.
- `src/core/PostUpdateMigrator.ts` — "Honest standby (turn-receipts)" CLAUDE.md section.

## Tests (all three tiers)

- **unit** `StuckSignatureClassifier.test.ts` — every kind positive + the
  negatives that matter (healthy session, STALE scrollback mention, normal
  compaction, prose-mentions-a-limit, empty), precedence, reset-hint parse.
- **unit (behavioral)** `presence-proxy-honest-receipts.test.ts` — drives the
  real `fireTier3` with a live child process: wedge → honest message NOT
  "working"; rate-limit → honest + waiting; deference → silent; context-too-long
  → recovery + announce; stale scrollback → no fire. Plus server.ts wiring guard.
- **unit (migrator)** `PostUpdateMigrator-honestStandbySection.test.ts` — section
  added + idempotent.
- Existing `presence-proxy-context-exhaustion.test.ts` updated for the new wiring.
