---
title: Outbound Content-Dedup — suppress the agent re-sending the same reply
date: 2026-06-06
author: echo
status: shipped
---

# Spec — Outbound Content-Dedup

**Date:** 2026-06-06 · **Author:** echo · **Status:** shipped (default-on)

## Triggering report

User: "We really need to work on not sending duplicate messages. Let's make
this much more robust." Screenshot: the SAME status posted to the EXO topic
three times. Grounded in `telegram-messages.jsonl`: fingerprint `ea240185` sent
**byte-identical at 21:14:54 and 21:28:28** — 13.5 minutes apart.

## Why the existing guards miss it

- **X-Instar-DeliveryId LRU** (`/telegram/reply`): catches a re-POST of the
  SAME delivery id. The two sends had DIFFERENT ids → not caught.
- **Tone gate** (`checkOutboundMessage`): has dup awareness, but it is SKIPPED
  for `isProxy` / `isSystemTemplate` / `willRelay` (cross-machine) sends, and is
  an LLM decision rather than a deterministic content guard.

Result: an agent re-announcing its last status after a restart/recovery, or a
relay re-emitting identical content under a fresh id, reaches the user twice.

## Design

`OutboundContentDedup` (`src/messaging/OutboundContentDedup.ts`) — a pure,
deterministic per-topic content fingerprint:

- `isDuplicate(topicId, text)` — true if the normalized text was sent to that
  topic within `windowMs` (default 15min). Pure read; does not record.
- `record(topicId, text)` — call AFTER a successful send.
- Normalization collapses whitespace; FNV-1a fingerprint + length tag.
- Per-topic ring (default 50), pruned by window + cap.

Wired at the `/telegram/reply` route, AFTER the delivery-id dedup and BEFORE the
tone gate (cheap — no LLM — and covers the proxy/relay paths the gate skips). On
`isDuplicate` → respond `200 { suppressedDuplicate: true }`, do NOT send. On a
successful send → `record`.

Deliberately NARROW to avoid suppressing legitimate repeats:
- **Length floor** (`minLength`, default 40): brief acks ("Got it, on it") are
  never deduped — a user who sends two messages must still see two acks.
- **`allowDuplicate` escape hatch** (existing route metadata): bypasses it for
  the rare caller that legitimately repeats a long message.
- **Record-after-success**: a failed send is never recorded, so its retry
  (same content, new id) is not wrongly suppressed.
- **Per-topic**: the same text to a different topic still sends.

## Signal-vs-authority

Deterministic guard at a chokepoint; no LLM. It suppresses an exact recent
duplicate — strictly removing a redundant send, never altering content. The
`allowDuplicate` hatch keeps caller authority for intentional repeats.

## Files

- `src/messaging/OutboundContentDedup.ts` (new) — the dedup.
- `src/server/routes.ts` — instance + check/record in `/telegram/reply`.
- `src/core/PostUpdateMigrator.ts` — "Duplicate-message suppression" CLAUDE.md note.

## Tests

- **unit** `OutboundContentDedup.test.ts` — catches the real 13.5-min repeat;
  whitespace-insensitive; window expiry; brief-ack exemption; per-topic;
  different-text passes; disabled no-ops; pure-read; ring cap; helpers.
- **unit (route)** `outbound-content-dedup-route.test.ts` — through the real
  `/telegram/reply` handler (no tone gate): first send goes; identical re-send
  → 200 suppressedDuplicate, never re-sent; different text sends; brief acks
  never suppressed; allowDuplicate bypass; cross-topic sends.
- **unit (migrator)** `PostUpdateMigrator-dupSuppressionSection.test.ts`.
