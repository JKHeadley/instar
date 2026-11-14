# Side-Effects Review — Meaning search over conversations

**Version / slug:** `conversation-search-meaning`
**Date:** `2026-11-14`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds `mode=meaning` to `GET /mobile/conversations/search` (stacked on PR 3162, the keyword half). New
files: `src/memory/ConversationEmbeddingIndex.ts` (the SQLite index of message vectors plus the
background feeder) and `src/server/conversationMeaningSearch.ts` (the index sources and the local
meaning search). Touched: the search route (meaning branch, a `meaning` dependency, the off switch
helper), `AgentServer` (builds the index and feeder when native conversations are on and the shared
embedding model is present, stops them on shutdown), `TopicMemory` (three read methods),
`AppConversationStore` (two read methods), `SemanticMemory` (a getter for its provider), config types
(`search.meaning.enabled`), the CLAUDE.md search line and its in-place migration, the CapabilityIndex
entry, the state-coherence registry (`derived-conversation-embeddings`).

Tier 1, declared below the risk floor deliberately: the index is a derived cache that refills from the
stores, the route returns only what the existing access checks allow, one live switch stops both the
route and the feeder, and a revert removes everything. The real new cost is a background process on
every agent with native conversations; it is bounded per tick, skips under load, and was measured (see
Interactions). Size: 2 new source files (~520 lines), 9 touched source files, 3 test files plus a test
helper. Effort: no spec review rounds (Tier 1), one build pass, two commits (the second records the measured backfill numbers).

## Decision-point inventory

- `deviceMayUse` / `mayReadStored` (existing access checks) — pass-through — meaning search builds the
  list of searchable conversations with the same checks as keyword and re-checks each app message.
- Feeder load gate (new, internal) — decides only whether the background indexer does its own work this
  tick (host CPU at least 85% busy or load above 1.0 per core ⇒ skip). It gates nothing else.

---

## 1. Over-block

The route refuses nothing new for keyword. Meaning answers 503 `meaning-unavailable` when the model or
index is absent; the app falls back to words. Hits below similarity 0.3 are dropped, so a weakly
related message may not show (a deliberate floor against noise). The feeder may skip indexing for a long
time on a machine that is always above 85% busy; meaning search then keeps answering with what is
indexed and `coverage` shows the gap.

## 2. Under-block

The concern is leaking a hit. The ref list handed to the vector query is built with the keyword path's
own checks and applied in SQL before ranking; every candidate is re-read from its store; app messages
pass `mayReadStored`; peer hits are re-judged here exactly as keyword's. The index holds no text, so a
leak of the index file exposes vectors and hashes, not messages (vectors are not text, though an
attacker with the model could learn rough topics — the file is 0600 in the state dir, like the stores
it derives from). Known gap: a long message is embedded from its first 1200 characters.

## 3. Level-of-abstraction fit

The index sits in `src/memory` beside the other embedding consumers and uses the shared
EmbeddingProvider (no second model). The sources read the exact dependencies the keyword route already
receives, so the two modes cannot drift on where messages come from. The vector query lives in the
index; visibility stays in the route layer with the existing checks.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

A read that returns only what existing authorities allow. The load gate is scheduling of its own work.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision. The similarity floor and the load thresholds are display and scheduling
bounds, not judgments about agent behavior.

## 5. Interactions

- **Keyword unchanged:** the keyword branch is untouched except the `mode` check now admits `meaning`;
  an integration test asserts the keyword answer is identical before and after a meaning failure and
  carries no new field.
- **Shared model:** the feeder and SemanticMemory share one provider (one ONNX thread,
  `ONNX_SESSION_OPTIONS`). While backfilling, the feeder keeps the model resident (its idle unload
  re-arms on each embed); once caught up and idle it unloads after 5 minutes as before.
- **Cost (measured, Mac Studio, 2026-11-14):** 200 real Telegram messages, first 1200 characters,
  one ONNX thread: 1867 ms wall, 1917 ms CPU, 9.3 ms per message, model load 159 ms (cached). Per tick
  at most 48 embeds or 600 ms of embedding ⇒ about 4.5% of one core per 10 s tick while backfilling;
  Echo's 40.8k Telegram rows take about 2.5 hours. A backfill sample through the real feeder, index
  and model (500 real Telegram messages, load check bypassed): 492 embedded, 11 ticks, average tick 367 ms,
  max 520 ms, 4.07 s CPU in all (8.3 ms per message), meaning query 4 ms (sqlite-vec). Each tick also reads up to 100 + 400 message ids per
  source (indexed SQL) and one primary-key lookup per id.
- **Load:** the tick is skipped when the host CPU is at least 85% busy (the heavy-work admission line)
  or the load average is above 1.0 per core; ticks never overlap; the event loop is yielded between
  embeds.
- **Races:** stores are appended while the feeder reads; a message landing mid-tick is picked up next
  tick. The index is single-writer (the feeder) with the route's `forget` of a gone message as the
  only other write.
- **Disk:** measured 5.2 MB for 500 messages, up to ~4 MB of it the write-ahead log; about 2 KB per row (~80 MB for 40k), capped at 200,000 rows (~400 MB worst case).

## 6. External surfaces

- The search route gains `mode=meaning`, the `coverage` field and 503 `meaning-unavailable` (with
  `reason`). No external systems, no network, no LLM calls.
- A new state file `state/conversation-embeddings.db` (registered, derived cache).
- Operator surface: none in this PR (the app and dashboard screens are separate).

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN for the index: each machine embeds the messages it holds (replicated app
conversations on every machine holding them, Telegram where TopicMemory has the topic, Slack only on the
machine holding it). Replicating vectors would copy every conversation a second time for nothing a local
re-embed cannot rebuild. The read is proxied: `scope=pool` merges peers' own meaning answers (agent
token, 5 s, 16 peers, 512 KB), names a machine that did not answer (including one answering 503), and
reports the lowest `coverage` of the machines that answered. No notices, no URLs, nothing stranded on
topic transfer (the receiving machine indexes what it holds).

## 8. Rollback cost

Set `mobilePairing.native.search.meaning.enabled: false` (read live: the route answers 503 and the feeder
stops working), or revert and ship a patch. The index file can be deleted at any time; it refills. The
CLAUDE.md line keeps describing meaning mode harmlessly until the next update.

## Conclusion

Clear to ship as Tier 1. Design choices from the brief worth naming: the index stores no text (re-read at
query time for current snippets and visibility); visibility is applied in SQL before ranking rather than
after a global top-k (a vec0 KNN table could not filter by ref, so a plain table with a scalar distance is
used); coverage counts looked-at messages including the too-short ones, so it can reach 1.

## Evidence pointers

- `tests/unit/conversation-meaning-search.test.ts` (16): upsert and replace, short messages, visibility
  before ranking, sqlite-vec and JS distance agree, model stamp reset, pruning, per-tick embed and time
  bounds, sweep resume and wrap, re-embed on a text change, immutable app rows never re-read, skips for
  load / off / no model, coverage, the paraphrase hit, the similarity floor, a gone message forgotten, a
  held app message skipped and kept, ref restriction, the sources.
- `tests/integration/conversation-search.test.ts`: through the real auth middleware, device allowlist and
  team log: meaning finds a paraphrase keyword misses, ref=, a member gets no unshared hit, 503 on model
  failure and on the off switch with keyword unchanged, a pool read with one dark peer.
- `tests/e2e/conversation-search-alive.test.ts`: a booted AgentServer with an injected model indexes an app
  message and answers `mode=meaning` 200 with coverage; without a model it answers 503.
