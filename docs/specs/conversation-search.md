---
title: Searching conversations (keyword now, meaning next)
slug: conversation-search
eli16-overview: conversation-search.eli16.md
status: draft
author: echo
created: 2026-11-14
tier: 1
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
operator-request: "Justin, Telegram topic 134088, 2026-11-14 01:29 PST: search conversations (both keyword and semantic search) and both all conversations and within a conversation"
---

# Searching conversations

## Why this exists

The operator asked to search conversations in the Instar iPhone app and the dashboard, by keyword and
by meaning, across every conversation and inside one. This spec covers both halves. The keyword half
is built in this PR (server route only). The meaning half is the next PR <!-- tracked: CMT-1758 -->;
the route is shaped so it adds a `mode` value and nothing else changes.

> **CMT-1758** — "Building in four PRs: filter/sort by app, pin conversations (agent-stored), keyword search across app/Telegram/Slack in app+dashboard, meaning search with the local engine"

## 1. The route

`GET /mobile/conversations/search?q=<text>&ref=<conversation ref>&mode=keyword&limit=<1-50>&scope=pool`

- **Callers:** the same as `GET /mobile/conversations`: a phone, a browser device, or the agent's own
  Bearer token (which reads as the owner). Device allowlist: `conversationRef: true`, its own bucket
  (`conversation-search`, 30 per minute), open to browser devices, team tier `guest` (searching is reading).
- **`q`:** 1-200 characters after trimming, else 400 `bad-query`. Its words are letters, digits and
  combining marks; a query with no words (only punctuation) answers 200 with no results.
- **`ref`:** `app:<uuid>`, `telegram:<topicId>` or `slack:<machineId>:<negative id>` (the canonical
  ref of the unread markers). Malformed ⇒ 400 `bad-ref`. A conversation the caller cannot list ⇒ 404
  `unknown-conversation`, the same answer a missing one gets. Without `scope=pool`, a conversation this
  machine does not hold is also 404.
- **`mode`:** `keyword` (the default). Any other value ⇒ 400 `mode-unsupported` until the meaning half ships.
- **`scope`:** absent ⇒ this machine. `pool` ⇒ every peer is asked for its own search with the agent's
  token (5 s each, at most 16 peers, 512 KB per answer), the answers merged. A team phone's pool read
  is answered from this machine only, as the list does.
- **Off switch:** `mobilePairing.native.search.enabled` (omitted ⇒ on wherever native conversations are
  on, read live, like `pins` and `unread`). Off ⇒ 503 `search-off`. Native conversations off ⇒ 503
  `native-conversations-off`.

Response 200:

```json
{ "query": "rocket", "mode": "keyword", "ref": null,
  "results": [ { "ref": "telegram:42", "platform": "telegram", "title": "Launches",
                 "messageId": "in:501", "at": "2026-11-09T10:00:00.000Z", "fromUser": true,
                 "snippet": "…the rocket launch went well…", "marks": [ { "start": 5, "length": 6 } ],
                 "rank": 1.42 } ],
  "partial": false, "failedMachines": [], "capped": false, "unsearched": [] }
```

- `machine` is present on Slack hits (the machine that holds the conversation; the history read's `machine=`).
- `messageId` is the id the history read gives that message, so the app can scroll to it:
  app conversation ⇒ the event id; Telegram ⇒ the logged row's event id when it has one (a message sent
  from the app), else `in:<n>` / `out:<n>` (`telegramRowId`); Slack ⇒ the row's event id when it has
  one, else `slack:<ts>`.
- `snippet` is about 160 characters around the first match, line breaks as spaces, "…" where cut;
  `marks` index into it in UTF-16 code units, one per matched word.
- Order: `rank` (higher first), newest first on a tie. The same message from two machines is listed once
  (this machine's copy wins).
- `partial` is true when anything was not searched: a peer did not answer (named in `failedMachines`),
  a scan stopped at its bound (`capped`), or an index could not be opened (`unsearched` names the platform).

## 2. Where the words are looked for

- **Telegram topics:** the TopicMemory FTS5 index (`porter unicode61`), every word required, each a
  prefix; restricted in SQL to the topics the caller can list (`json_each`), `LIMIT` in SQL (three times
  the page, at most 150); the matched spans come from FTS5 `highlight()` with private-use markers.
- **App conversations:** the conversation store, newest messages first: at most 1000 per conversation
  and 5000 in all (5000 inside one conversation with `ref=`). The index is not used because app rows are
  only written there with `contextBudget.enabled`, which is off on most agents.
- **Slack conversations:** the rows the Slack history read serves (the cached log tail plus the in-memory
  ring), at most 1000 per conversation. The index is not used because Slack rows are filed per channel,
  without the thread, so a hit could not be tied to a thread conversation.
- Scans use the same word rule as the index (word-start prefix, case-insensitive, every word). One ranking
  (`hitScore`, BM25-shaped: marked words against text length) is applied to every hit so the three sources
  compare. No LLM calls.

## 3. Visibility (never more than the list)

- Each conversation is checked with the list's own check (`deviceMayUse`): Telegram `telegram:<n>`, app
  by key, Slack the one owner-only `slack:` check. Only Telegram topics the list shows are searched.
- Inside an app conversation, each message passes `mayReadStored` (a team member never sees a held message).
- Memory privacy: the list and history reads do not apply it, so search does not either.
- A peer's hit is re-validated (ref shape, a peer may only answer for its own Slack, id shape, marks inside
  the snippet) and then judged on THIS machine with the same check; an app conversation not replicated
  here fails closed for a phone that needs its owner record.

## 4. Meaning search (next PR) <!-- tracked: CMT-1758 -->

`mode=meaning` returns the same result shape, ranked by meaning instead of word overlap, with the same
visibility and pool rules. Its index, model and cost bounds are designed in that PR; until then the route
answers 400 `mode-unsupported` for it.

## Multi-machine posture

Proxied-on-read: each machine searches what it holds; `scope=pool` merges every machine's answer through
the agent-token fan-out, naming a machine that did not answer. No durable state, no notices, no URLs.

## Decision points touched

None that gate or block: the route filters results with the existing access checks (`deviceMayUse`,
`mayReadStored`) and adds no new authority.
