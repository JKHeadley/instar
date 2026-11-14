---
title: Searching conversations (keyword and meaning)
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
by meaning, across every conversation and inside one. This spec covers both halves (server route only):
keyword search (§1-§3, PR 3162) and meaning search (§4, stacked on it). Meaning search adds a `mode`
value, a background index and one response field; the keyword answer does not change.

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
- **`mode`:** `keyword` (the default) or `meaning` (§4). Any other value ⇒ 400 `mode-unsupported`.
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

## 4. Meaning search

`GET /mobile/conversations/search?q=<text>&mode=meaning[&ref=…][&limit=…][&scope=pool]` answers in the
keyword shape, ranked by how close a message's meaning is to the query, with the same callers, rate
bucket, visibility, `ref=` rules and pool fan-out as keyword. It finds a message that says the same
thing in other words ("spaceship liftoff" for "rocket launch").

### 4.1 Contract additions

- `mode: "meaning"` in the answer, and **`coverage`**: the fraction (0-1, three decimals) of the messages
  this machine holds that its index has looked at so far (embedded, or ruled too short), or `null` when a
  store cannot count its messages. Below 1 the phone can say "still learning older messages". It is
  machine-wide (not narrowed by `ref=`) and it does not set `partial`. A pool answer gives the lowest
  coverage of the machines that answered.
- Each hit: `rank` is the cosine similarity (0-1, higher first), comparable across machines (same model),
  so pool merging and dedupe work as for keyword. `snippet` is ~160 characters around the first literal
  query word when one occurs (and `marks` mark those words), else the start of the message (`marks: []`).
- Hits below similarity 0.3 are dropped (the model puts unrelated text near 0-0.2), so a query about
  nothing in the conversations answers no results rather than the nearest noise.
- **503 `meaning-unavailable`** with `reason`: `off` (the switch below), `no-index` (no model on this
  machine, or the index file could not be opened), `model-failed` (embedding the query threw),
  `index-failed` (the vector query threw). The app then searches by words. A peer answering 503 is named
  in `failedMachines` (as any refusal is). `mode=keyword` is unchanged byte for byte: no `coverage` field.
- **Off switch:** `mobilePairing.native.search.meaning.enabled: false` (omitted ⇒ on wherever search is
  on; read live): meaning answers 503 `meaning-unavailable` (`reason: off`) and the background embedder
  does no work. `search.enabled: false` turns both modes off (503 `search-off`).

### 4.2 The index

`src/memory/ConversationEmbeddingIndex.ts`, one SQLite file per machine at
`<stateDir>/state/conversation-embeddings.db` (mode 0600, WAL; registry category
`derived-conversation-embeddings`). One row per message: `(ref, key)` primary key (app: event id;
Telegram: the Telegram message id; Slack: the message ts), `platform`, `at`, `from_user`, a 24-hex sha-256
of the embedded text, and the vector (384 float32, the shared local all-MiniLM-L6-v2 model that
SemanticMemory loads at boot; no new model, no network, no LLM). A row with no vector marks a message
under 3 words (looked at, not embedded). **The index holds no message text**: a search re-reads each
candidate from its own store, so snippets are current and a message that is gone is dropped and its row
forgotten. A different model or dimension stamp in `meta` empties the index; a corrupt file is set aside
and refilled. At most 200,000 rows (the newest kept).

Each message is embedded as the phone sees it (`deviceTextForRow` / `slackDeviceText`), its first 1200
characters (the model reads ~256 tokens; the start carries the topic). Known limit: the meaning of a long
message is judged from its beginning.

### 4.3 Feeding it (background, throttled)

A feeder fills the index from the same sources keyword search reads: TopicMemory rows (Telegram), the app
conversation store (live native conversations only), and the Slack rows the history read serves. Every
10 s (first tick 60 s after boot; unref'd timer; stopped on server stop) it:

1. skips the tick when meaning or search is off, native conversations are off, the model is absent, or the
   machine is busy: host CPU at least 85% busy since the last tick (idle under 15%, the line the
   heavy-work admission hook uses) or the 1-minute load above 1.0 per core;
2. checks the newest 100 messages of every source (a new message is searchable within a tick or two);
3. continues one sweep page (400) per source, newest first through the older messages; when a sweep
   reaches the oldest message it starts again from the newest, which picks up late-replicated messages
   and edited text (the hash differs). App events never change, so a present app row is never re-read;
4. stops embedding at 48 messages or 600 ms of embedding time in the tick, whichever comes first,
   yielding to the event loop between embeds; the sweep resumes after the last message it handled.

Cost, measured on the Mac Studio (2026-11-14, 200 real Telegram messages cut to 1200 characters, one ONNX
thread, the existing `ONNX_SESSION_OPTIONS`): 9.3 ms of one core per message; a tick is at most ~450 ms
of one core per 10 s, about 4.5% of ONE core while backfilling and nothing once caught up. Echo's 40.8k
Telegram messages backfill in about 2.5 hours. The model is already resident at boot (SemanticMemory),
so the added memory is the index file (~1.6 KB per message: ~65 MB for 40k).

### 4.4 Searching it

The route embeds the query (one ~10 ms model call), then asks the index for the nearest
`min(150, 3 × limit)` rows **among the refs the caller can list only** (the keyword path's own
`deviceMayUse` checks; the ref list goes into SQL, so a hidden conversation never takes a place in the
top k). Distance is `vec_distance_cosine` from sqlite-vec when it loads into this connection, else an
equivalent JS cosine registered on the connection (a full scan either way; bounded by the 200,000-row
cap). Each candidate is re-read: an app message must pass `mayReadStored` (a held message is skipped,
never forgotten), Telegram's history id is mapped as keyword does, Slack is read from the history rows.
A vector or model failure answers 503 and never affects keyword search.

### 4.5 Tier

Tier 1, recorded: the index is a derived cache (deleting the file loses nothing; it refills), the route
only returns what the existing checks allow, the live off switch stops both the route and the feeder, and
a revert removes it. It does add a background process on every agent with native conversations; its cost
is bounded per tick and measured above, and it skips under load.

## Multi-machine posture

Proxied-on-read: each machine searches what it holds; `scope=pool` merges every machine's answer through
the agent-token fan-out, naming a machine that did not answer. Keyword search keeps no durable state.
The meaning index is **machine-local by design**: each machine embeds the messages it holds (a replicated
app conversation is embedded on every machine that holds it, a Telegram topic where TopicMemory has it,
Slack only where it is held), and the pool read merges answers; replicating vectors would ship a second
copy of every conversation for nothing a local re-embed cannot rebuild. No notices, no URLs.

## Decision points touched

None that gate or block: the route filters results with the existing access checks (`deviceMayUse`,
`mayReadStored`) and adds no new authority. The feeder's load check only decides whether background
indexing runs this tick (its own work), never anything else.
