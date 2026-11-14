## What Changed
- **Meaning search over conversations.** `GET /mobile/conversations/search?q=<words>&mode=meaning` finds messages that mean the same thing in other words ("spaceship liftoff" for "rocket launch"), in the same answer shape as keyword search, across every conversation the caller can list or inside one (`ref=`), on this machine or every machine (`scope=pool`). Hits are ranked by similarity (`rank`, 0-1).
- **A local index, filled in the background.** Each machine embeds the messages it holds with the local all-MiniLM-L6-v2 model the agent already loads at boot (no download, no AI service), newest first, at most 48 messages or 600 ms of work per 10 seconds, and not at all when the machine is busy. The index file (`state/conversation-embeddings.db`) holds numbers and hashes, never message text.
- **Honest progress.** Each meaning answer carries `coverage`, the share of this machine's messages learned so far (the lowest across machines for a pool read), so the app can say it is still learning older messages.
- **Same visibility as the list.** A team member never gets a hit from a conversation they were not given, or a message held from them.
- **Fallback and off switch.** No model or index ⇒ 503 `meaning-unavailable` (the app searches by words). `mobilePairing.native.search.meaning.enabled: false` turns meaning search and its background work off; keyword search is unchanged.

## What to Tell Your User
Your conversations can now be searched by meaning as well as by words, once the search screens arrive in the app and the dashboard: ask for something in your own words and I find the messages that are about it, even when they used different words. I learn older messages gradually in the background without slowing anything down, and the search says when I am still catching up.

## Summary of New Capabilities
- Meaning search across all conversations or within one, on this machine or every machine, with a progress figure.

## Evidence
- `tests/unit/conversation-meaning-search.test.ts`: index storage, re-embedding on a text change, short messages, visibility before ranking, both distance paths, per-tick bounds, sweep resume, load/off/no-model skips, coverage, the paraphrase hit, the similarity floor, held and gone messages.
- `tests/integration/conversation-search.test.ts`: real auth and team log: meaning finds a paraphrase keyword misses, a member gets no unshared hit, 503 on model failure and on the off switch with keyword unchanged, a pool read with a dark peer.
- `tests/e2e/conversation-search-alive.test.ts`: a booted server indexes and answers meaning search (200 with coverage), 503 without a model.
- Cost measured on the Mac Studio: 9.3 ms of one core per message (200 real messages), about 4.5% of one core while catching up.
