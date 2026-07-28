---
title: A forwarded follow-up to a moved session injects, not re-spawns (owner-side dispatch)
slug: owner-side-followup-inject
status: approved
review-convergence: 2026-05-31T13:55:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h deploy mandate (topic 13481). Audit
  item #13 of the multi-machine live-transfer cascade — found by code audit (the same
  method that surfaced bug #2), not yet live. A latent defect in the owner-side
  follow-up path: it would have broken the live "move + follow-up" test. Gated past
  'dark' + fail-safe; unit-verified. Flagged in the PR per cross-agent discipline.
---

# A forwarded follow-up to a moved session injects, not re-spawns

## Problem

Audit finding #13, confirmed in code. After the session pool moves a topic to a
standby (the new owner), every subsequent inbound message for that topic arrives at
the owner ONLY via MeshRpc `deliverMessage` → the `onAccepted` callback (the owner
is tokenless and never polls Telegram). `onAccepted` called `spawnSessionForTopic`
**unconditionally** on every forwarded message, passing
`tg.getSessionForTopic(topicId)` as the spawn name.

Two defects compound there:

1. **Double-prefix duplicate.** `registerTopicSession` stores the *returned* tmux
   session name (already `<projectBase>-topic-N`). On the next follow-up,
   `getSessionForTopic` returns that prefixed name, and `spawnInteractiveSession`
   re-prefixes it (`<projectBase>-<projectBase>-topic-N`). `tmuxSessionExists` misses,
   so a **brand-new duplicate session is spawned for every follow-up** instead of the
   message reaching the running moved session.
2. **No inject path.** Even without the prefix bug, the owner side never mirrored the
   normal inbound dispatch, which injects a message into an already-running session
   (`injectTelegramMessage`) rather than re-spawning. So the moved conversation never
   advanced — each follow-up either started fresh or duplicated.

Net effect: the live "move this to the mini" + a follow-up asking for a reply — the
exact two-step the live test performs — would move correctly but then mishandle the
follow-up (duplicate/blank session), so the reply would not come from the moved
session. The transfer would look broken at exactly the step that matters.

## Goal

On the owner machine, a forwarded follow-up for a topic that already has a live
session is **injected into that session** (with the `[telegram:N …]` prefix the
session expects), exactly as the normal single-machine inbound path does. A session
is spawned **only** when none is running, and the spawn always uses a clean
topic-derived name — never the prefixed `getSessionForTopic` value.

## Non-goals

- Not a change to the normal single-machine dispatch (untouched) — this only fixes
  the owner-side `onAccepted` forwarded-message path.
- Not a change to ordering/dedup (the router already enforces per-session ordering
  and messageId dedup upstream).
- Gated past `'dark'` and fail-safe: a single-machine agent never reaches this code.

## Design

In `server.ts` `onAccepted` (the only owner-side entry for forwarded messages):

1. **Inject-into-live first.** Resolve `existing = tg.getSessionForTopic(topicId)`.
   If `existing` is set and `sessionManager.isSessionAlive(existing)`, call
   `sessionManager.injectTelegramMessage(existing, topicId, text, topicName)` and
   `tg.trackMessageInjection(topicId, existing, text)`, then return. This mirrors the
   normal inbound dispatch's alive-session branch.
2. **Spawn only when none.** Otherwise spawn the moved session (with the bug-#2
   relayed context) under a clean `spawnName = `topic-${topicId}``. The returned tmux
   name is registered via `registerTopicSession`, so the *next* follow-up takes the
   inject branch above. The spawn name is never the prefixed `getSessionForTopic`
   value (that was the double-prefix defect).

## Testing

- Wiring (`tests/unit/session-pool-activation-wiring.test.ts`): the owner-side bridge
  injects into a live session before the spawn IIFE (`isSessionAlive(existing)`
  precedes `spawnSessionForTopic`), uses `injectTelegramMessage` +
  `trackMessageInjection`, and spawns under `topic-${topicId}` — never the prefixed
  name. 52 session-pool + adapter tests green; `tsc --noEmit` clean.
- **NOT yet live-verified** — the moved session running on the mini (and thus the
  follow-up round-trip) can only be confirmed once the mini's Claude is logged in
  (bug #12, pending Justin). The logic is unit-proven; the live follow-up is the
  Tier-3 gate that follows his login.

## Migration parity

Pure code (one branch in `onAccepted` + a clean spawn name). No config/hook/route/
CLAUDE.md change. Gated past `'dark'` + fail-safe → existing agents unaffected until
the pool is on; they get it on the v-next update.
