---
title: Tokenless standby relays outbound Telegram through the owning router
slug: standby-telegram-outbound-relay
status: approved
review-convergence: 2026-05-31T12:40:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h deploy mandate (topic 13481). Bug #7
  of the multi-machine live-transfer cascade — the TRUE completion gate: a session
  moved to a tokenless standby could not reply. Found live (mini botToken=MISSING).
  Relays through the router to preserve the single-Telegram-owner invariant (avoids
  the 409-poller-conflict incident). Flagged in the PR per cross-agent discipline.
---

# Tokenless standby relays outbound Telegram through the owning router

## Problem

The final gate of the live-transfer cascade. With #4–#11 fixed, "move this to the
Mac mini" forwards, the mini accepts, spawns, persists, runs the session, and
ownership finalizes. But the mini is a SILENT STANDBY with **no Telegram bot token**
(`botToken=MISSING`, verified) — deliberately, so it never polls/sends on the shared
bot (the 409-poller-conflict guard). So when a session moved to the mini generates a
reply, `TelegramAdapter.sendToTopic` calls the API with no token and the reply is
MUTE: the transfer "completes" but the user never hears back.

## Goal

A session moved to a tokenless standby can reply to the user, WITHOUT the standby
ever sending on the shared bot — by relaying its outbound send through the
Telegram-owning router (the lease holder), preserving the single-owner invariant.

## Non-goals

- Does NOT give the standby its own bot token / direct send (that would re-introduce
  the 409-poller-conflict — two senders/pollers on one bot).
- Does NOT change a token-holding machine's send path (the relay is a no-op there).
- Does NOT add cross-machine conversation-context sync (audit #2 — separate).

## Design

1. **`TelegramAdapter` gains a settable `outboundRelay` callback** (mirrors the
   existing `onMessageLogged`-style public hooks). In `sendToTopic`, when the adapter
   has NO token (`!this.config.token`) AND `outboundRelay` is wired, the send routes
   through it instead of `apiCall`; the relayed message id flows into the SAME
   bookkeeping (log / stall-clear / promise-tracking). A relay that returns null
   throws (no silent drop). A token-holding adapter is byte-identical to today.

2. **`server.ts` wires `outboundRelay`** to POST the lease holder's
   `/telegram/reply/:topicId` (the existing send route) with the shared Bearer
   `authToken` and the holder's known peer URL. It refuses to relay to self
   (`holder === meshSelfId`) or when the holder/URL is unknown (returns null →
   surfaced). This reuses the battle-tested reply route on the owner; no new mesh
   command, no token on the standby.

## Testing

- Tier 1 (`TelegramAdapter.test.ts`): a tokenless adapter routes `sendToTopic`
  through `outboundRelay` (relay called, the Telegram API NOT hit, the relayed id
  returned); a token-holding adapter still hits the API and never consults the relay;
  a relay returning null throws (no silent mute).
- 19 TelegramAdapter tests green; `tsc --noEmit` clean.
- Tier-3: the live re-test (fresh topic) — a session moved to the mini replies and
  the reply LANDS in Telegram (relayed through the laptop). This is the completion
  gate for SESSION_POOL_PROVEN_AND_VERIFIED.

## Migration parity

Pure code (one settable callback + a send branch + the server wiring). No config/hook/
route/CLAUDE.md change. The callback defaults null → a non-pool / token-holding agent
is unaffected. Existing agents get it on the v-next update.
