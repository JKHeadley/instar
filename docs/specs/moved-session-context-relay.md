---
title: A moved session inherits its prior conversation (cross-machine context relay)
slug: moved-session-context-relay
status: approved
review-convergence: 2026-05-31T13:10:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h deploy mandate (topic 13481). Audit
  item #2 of the multi-machine live-transfer cascade — a quality fix so a moved
  session is USEFUL, not just functional. UNIT-VERIFIED; live verification pends the
  mini's Claude login (bug #12, a Justin credential action). Flagged in the PR per
  cross-agent discipline.
---

# A moved session inherits its prior conversation

## Problem

Audit finding #2, confirmed in code. When the session pool moves a topic to a standby,
the standby spawns the session locally — but its OWN message ledger for that topic is
EMPTY (it never polled the topic) and its TopicMemory has no rows. So
`spawnSessionForTopic` builds `contextContent = ''` (the TopicMemory branch is skipped;
`telegram.getTopicHistory()` returns `[]`), and the moved conversation starts with
amnesia: the user's prior exchange is gone and the session "continues" a thread it
can't see.

## Goal

A session moved to a standby continues the SAME conversation — it inherits the recent
history from the machine that was serving it (the router), rather than starting blank.

## Non-goals

- Not a shared/replicated message ledger (the broad architectural fix) — this is a
  targeted at-spawn fetch from the router, sufficient for continuity. A durable shared
  ledger remains a separate, larger piece.
- Best-effort: on any fetch failure the session still spawns (without prior history),
  exactly as today — never blocks the move.
- Does not change the single-machine spawn path (no router → no precomputedContext →
  the existing TopicMemory/JSONL logic is byte-identical).

## Design

1. **Pure helper `formatForwardedTopicContext(messages, topicName?)`**
   (`src/core/ForwardedTopicContext.ts`) — formats fetched router history into the same
   "Thread History" block the single-machine JSONL path produces (sender attribution,
   the continue-not-restart guard, 2000-char per-message cap). Returns '' for empty.

2. **`spawnSessionForTopic` gains `precomputedContext?`** — when provided it is used
   verbatim as the context and the (empty-on-a-standby) TopicMemory/JSONL sources are
   skipped. Default undefined → unchanged single-machine behavior.

3. **The owner-side resume fetches it** (`server.ts` onAccepted): before spawning a
   forwarded session it GETs the router's `/telegram/topics/:topicId/messages?limit=50`
   (Bearer authToken; router URL via the new `_resolveRouterUrl` = the lease holder's
   peer URL), formats it, and passes it as `precomputedContext`. Wrapped best-effort.

## Testing

- Tier 1 (`ForwardedTopicContext.test.ts`): empty→'', multi-message formatting with
  attribution + the continue guard + topic name, sender/timestamp fallbacks, the
  per-message length cap.
- Wiring (`session-pool-activation-wiring.test.ts`): the owner-side bridge still spawns
  + fails safe (now wrapped in the history-fetch IIFE).
- 51 session-pool + adapter tests green; `tsc --noEmit` clean.
- **NOT yet live-verified** — a moved session retaining context can only be confirmed
  once the mini's Claude is logged in (bug #12, pending Justin). The logic is unit-proven;
  the live round-trip is the Tier-3 gate that follows his login.

## Migration parity

Pure code (one helper + one optional param + the onAccepted fetch + a module resolver).
No config/hook/route/CLAUDE.md change. Gated past `'dark'` + best-effort → existing
agents unaffected until the pool is on. Existing agents get it on the v-next update.
