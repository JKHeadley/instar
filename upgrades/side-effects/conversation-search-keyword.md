# Side-Effects Review — Keyword search over conversations

**Version / slug:** `conversation-search-keyword`
**Date:** `2026-11-14`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds `GET /mobile/conversations/search` (new file `src/server/mobileConversationSearchRoutes.ts`, pure
helpers in `src/core/conversationKeywordSearch.ts`, one query method `TopicMemory.searchKeyword`), mounted in
`AgentServer` right after the conversation router. Telegram topics are searched through the TopicMemory
FTS5 index; app conversations and Slack by a bounded scan of the rows their history reads serve. Results
carry the conversation ref and the history message id. Device allowlist, browser routes and team tier gain
one rule each (`mobilePairingRoutes.ts`). Config type gains `mobilePairing.native.search.enabled` (omitted ⇒ on,
as `pins` and `unread`). The CLAUDE.md template gains one line with a content-sniffed migration
(`PostUpdateMigrator`), and the CapabilityIndex entry names the route. Tier 1: new read-only route, revert
undoes it. Size: 3 new source files' worth of code (~520 lines), ~8 touched files, 2 test files. Effort: no
spec review rounds (Tier 1), one build pass.

## Decision-point inventory

- `deviceMayUse` / `mayReadStored` (existing access checks) — pass-through — the route filters hits with them; no new check.
- `DEVICE_ALLOWLIST` / `BROWSER_ROUTES` / `TEAM_ROUTE_TIERS` — modify — one new read rule each (conversationRef, own bucket, guest tier).

---

## 1. Over-block

No block/allow surface beyond the existing access checks. A query of punctuation only returns no results
rather than an error. A query over 200 characters is refused (400) — a deliberate bound.

## 2. Under-block

The concern is leaking a hit. Every conversation goes through the list's check; app messages through
`mayReadStored`; peer hits are re-judged here. A Telegram topic absent from the topic mappings is never
searched (the list does not show it). Known gap, by design: messages older than the scan bound in app or
Slack conversations are not found; the answer says so (`capped`, `partial`).

## 3. Level-of-abstraction fit

A read route beside the list it mirrors, reusing the list's access checks, the shared ref canonicaliser
and the pool fan-out primitives (`poolPeerFetch`, `isPeerUrlAllowedForCredentials`). The FTS query lives in
TopicMemory, which owns the index. It does not touch `mobileConversationRoutes.ts` (a parallel pins PR edits it).

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It is a read that returns only what existing authorities already allow.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The ranking is display order only.

## 5. Interactions

- **Shadowing:** `GET /mobile/conversations/search` does not collide with `/mobile/conversations/:key` routes (those are PATCH/DELETE, and GET only on `/:key/placement`).
- **Double-fire:** none; read-only.
- **Races:** reads the store and index while writers append; a message landing mid-scan may or may not appear, which is fine for a search.
- **Rate:** its own device bucket (30/min), so typing never uses the shared read allowance an emergency stop relies on.
- **Load:** FTS with SQL LIMIT; scans bounded (5000 app messages, 1000 Slack rows per conversation, 20000 total); the Slack tail parse is the cached one the history read uses.

## 6. External surfaces

- New route visible to phones, browser devices and the Bearer token. No external systems touched. No persistent state written.
- Operator surface: none in this PR (the app and dashboard screens are separate); the agent can call it with its token.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Proxied-on-read: each machine searches what it holds; `scope=pool` merges peers' own searches (agent token,
5 s, 16 peers, 512 KB), names a machine that did not answer in `failedMachines`, collapses duplicates, keeps
Slack hits only from the machine that holds them. No notices, no durable state, no URLs. No status surfaces changed.

## 8. Rollback cost

Pure code change: revert and ship a patch, or set `mobilePairing.native.search.enabled: false` (503
`search-off`, read live). The CLAUDE.md line added by migration stays harmlessly describing a route that 503s
until the next update.

## Conclusion

Clear to ship as Tier 1. The one design change from the brief: app and Slack are scanned rather than indexed,
because the index does not reliably hold them; this is stated in the spec and the response.

## Evidence pointers

- `tests/unit/conversation-search.test.ts` — words, FTS expression, matcher, highlight reader, snippets and marks with non-ASCII text, the index query, per-channel ref and message id mapping, visibility filters, peer hit validation, order, off switch.
- `tests/integration/conversation-search.test.ts` — through the real auth middleware, allowlist and team log: owner hits in all three channels, a member never sees an unshared conversation, `ref=`, the errors, the off switch, a pool read with one answering and one dark peer.
