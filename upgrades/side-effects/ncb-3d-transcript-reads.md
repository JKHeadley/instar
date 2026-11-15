# Side-Effects Review — Signed transcript and history reads over the mesh (NCB slice 3d)

**Version / slug:** `ncb-3d-transcript-reads`
**Date:** `2026-11-11`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Builds slice 3d of `docs/specs/native-conversation-any-machine-access.md` (F4: the Mama PC could not read the M5 Pro's or the Studio's transcript, "peer URL refused" / "token refused").

- New mesh verb `session-transcript-pull` (`src/core/sessionTranscriptPull.ts`, registered on the production dispatcher in `src/commands/server.ts`), read/observe RBAC class. Modes `transcript` (one page of a session's record, for a session recorded on the serving machine, never a path; every answer names the session's `conversations`) and `list` (this machine's own session list).
- `topic-history-pull` gains `shape: 'pool'` with `before`, `beforeMessageId`, `limit` up to 100, whole rows (ids, provenance, origin join), a 512 KiB cap, `truncated` + `oldest` cursor, and the oversized-row continuation; the answer echoes `shape`. The default shape is unchanged.
- Shared oversized-row rule (`src/core/oversizedRow.ts`): a page is built newest first; a row alone larger than the cap is returned cut on a UTF-8 boundary with `rowTruncated: { row, totalBytes, from, to }` and read on by `row` + `byteFrom`; redaction runs before the cut and all counts are in the redacted row; the page cursor always moves past the cut row.
- `SessionTranscriptReader`: each entry carries `index` (its position within its record) and `clipped: true` when the 4,000-character cut applied; new `full` option lifts the cut; new `beforeIndex` option makes the cursor offset-plus-index, so a page that ends inside one record neither skips nor repeats an entry.
- Routes (`src/server/routes.ts`): `/sessions/:name/transcript?machineId=`, the pool History fan-out of `/telegram/topics/:id/messages?scope=pool`, and `/sessions?scope=pool` try the signed verb first. Bearer fallback only on `no-handler`, on `claim-unauthorized` from a peer whose version advert is absent or older than `SIGNED_POOL_READS_MIN_VERSION`, or (pool history) a success that does not echo `shape: 'pool'`. A timeout or other error is reported as that machine's failure (`asleepOrUnreachable` with id, name, last-seen), never downgraded. Capability is remembered per machine, per kind and per version (`src/core/poolSignedReads.ts`); `GET /pool/signed-reads` lists `signedCapable` and `bearerFallbackNeededBy`.
- Audience (`src/core/transcriptAudience.ts`): the transcript route answers the owner only, where the owner may see every conversation the session served (most restrictive), resolved at read time from this machine's confined list and signed team record; refused while the team log has a gap or the team puller is refusing (team access on); `unreadable` fails closed; a device principal is refused outright; an answer with no `conversations` field is served on a never-team agent and refused with team access on. Applied on the serving machine's local route and on the asking machine for a remote answer. No device route is added.
- Redaction: the serving machine removes its own API token and dashboard PIN from every entry before any clip or cut (the local route now always does, not only with `redact=device`).
- Dashboard History paging carries `beforeIndex`. CLAUDE.md awareness for new agents (`generateClaudeMd`) and existing agents (`migrateClaudeMd` + framework shadow), guarded by a content marker.

Tier 2 (spec-driven, published wire contract). Size: about 15 files, roughly 1,300 added lines including tests. Effort: one build pass; commit attempts recorded in the status note.

## Decision-point inventory

- Bearer fallback permitted? — **modify** (was: always bearer). Now a closed rule over a definite mesh answer.
- Transcript audience — **add** (invariant, enumerable domain per the spec's Decision points table).
- Byte cap 512 KiB, page sizes 500 / 100, 4,000-character clip — **pass-through** (judgment-candidate values within the spec's floor; values are the consumers' existing bounds).

---

## 1. Over-block

- A team agent whose answering machine is older (no `conversations` field) refuses the owner the transcript until that machine updates. Intended (spec §3d item 2); the sentence says why.
- With team access on, a team-log gap or a refusing puller refuses the owner's transcript read even for a session with no conversation? No: a session with no conversations is checked for currency first, so yes, it is refused while the log has a gap. The spec places the currency test on "the owner's read" generally; a no-conversation session is refused during a gap. Accepted: gaps are short and the sentence is plain.
- `claim-unauthorized` from a peer advertising ≥ `1.3.1740` that genuinely lacks the verb (a build between that version number and the actual release carrying this PR) is treated as a real refusal: no fallback, reported as that machine's failure. See Open problem 1 in the status note: the constant must equal the release that ships this change.
- The local route now always removes the API token and PIN from transcript text, also for the owner's dashboard. A transcript that quoted the token shows `[redacted]`. Not a legitimate need being blocked.

## 2. Under-block

- A session running on a machine can read transcript files on that disk directly (spec §3d item 2 Stated limit, accepted).
- A machine cut off before a conversation became private to someone else, whose peers show no sign of being awake, still shows the owner that session (spec Stated limit, by design of the puller).
- "Conversations a session served" is read from the session record (topic id, Slack channel, memory place input). A session that served more than one conversation over its life is not tracked by the record; instar sessions serve one conversation. Left behind 11 in the spec.
- The 200-character tool-input summary has no in-band mark (spec Left behind 13).

## 3. Level-of-abstraction fit

The verb lives beside `topic-history-pull` in the mesh layer; the audience decision is a pure function consumed by the route, where a person is answered (the spec places it there). The capability cache is per-server, held by the route module, which is the only consumer. The serve side reuses the plain local routes over loopback for the list and pool history, so the signed answer carries exactly what the bearer answer did (origin join included) without duplicating that logic.

## 4. Signal vs authority compliance

Required reference: docs/signal-vs-authority.md.

The audience rule holds authority (refuses a read), but it is not a brittle heuristic: it is a closed decision over the signed team record and the confined list (enumerable domain, invariant class in the spec), failing closed on unreadable input. The fallback rule is a closed set of definite mesh answers; nothing pattern-matches text. The capability cache is a signal (an observation of what a peer answered), never authority beyond choosing transport.

## 4b. Judgment-point check

No competing-signals decision point gets a static heuristic. The caps and page sizes are judgment-candidate values within a floor (every text readable in full, cursor always advances, every cut marked), with the 3f spec as arbiter.

## 5. Interactions

- `topic-history-pull` default shape: unchanged; the moved-session pull (`pullMovedTopicHistory`) is unaffected. The handler dispatch in `server.ts` checks `shape !== 'pool'` first.
- RBAC: the new case sits before `topic-history-pull` so the existing source tests pinning `case 'topic-history-pull':\n\s+case 'topic-row-pull':` still hold.
- Mobile History (`mobileSessionControlsRoutes`) calls the local transcript route by loopback: it now passes the audience check (owner token) and receives redacted text (it already redacts). Local pages without `full` keep record-boundary paging, so its numeric `nextBefore` stays correct.
- Dashboard History: carries `nextBeforeIndex` for remote pages cut inside a record.
- 3b (PR #3092) touches `server.ts` and `PostUpdateMigrator.ts` in other places; textual merge only.

## 6. External surfaces

- Wire contract: new verb, new optional fields on `topic-history-pull`. Older peers: covered by the fallback rule both ways (an older asker never sends `shape`; an older server answers without the echo or with `claim-unauthorized`).
- HTTP answers gain `via`, `machineId`, `conversations`, `nextBeforeIndex`, `clipped`, `rowTruncated`, `truncated`, and `pool.via` / `pool.asleepOrUnreachable` / `pool.truncated`. All additive.
- New read route `GET /pool/signed-reads` (under the existing `/pool` prefix).
- Refusal sentences are the fixed strings of FD-15 / §3d.
- Depends on runtime conditions: peer version adverts (absent means "older" for the fallback rule, the safe direction for reach, since a real denial from an advert-less peer would then be retried by bearer, which that peer's own auth still refuses).

## 6b. Operator-surface quality

Touches `dashboard/console/sessions.js` and `sessions-model.js` only to carry the paging index; nothing rendered changes.
1. Leads with the primary action: unchanged (History view).
2. Zero raw internals: no new visible fields; the index is a query parameter.
3. Destructive actions: none.
4. Plain language + phone width: unchanged layout; refusal sentences are plain English and shown through the existing History error line.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Session transcripts: **proxied-on-read** over the signed verb until 3f replicates them (spec: `machine-local-justification: migrating-to-unified ... tracking=commitments.CMT-047`).
- `signedCapable` per machine and kind: **machine-local by design**, a derived cache of what this machine observed, rebuilt by the next read; losing it costs one bearer attempt against an older peer.
- No user-facing notices, no durable state, no generated URLs.
- Status surface: `GET /pool/signed-reads` is **this machine's** view of each peer (it is what this machine has itself observed); a peer never read reads `false` for every kind, never `true`.

## 8. Rollback cost

By version. The bearer hop is still in the code, so a rolled-back machine reads as it does today. No data migration; the CLAUDE.md section stays harmlessly (it describes the verb; an older build ignores it).

## Conclusion

Builds the whole of slice 3d as specified. Clear to ship once the second pass concurs and Local Verify is green.

## Second-pass review

**Reviewer:** independent second-pass subagent
**Independent read of the artifact: concur** (after the builder's fixes, re-checked)
Re-checked in code:
- (1) The pool History route has a continuation branch (machine, row, byteFrom), marks `rowTruncated` on the cut row itself, and removes rows older than a cut-short machine's oldest row before merging.
- (2) The app conversation key comes from the channel alias in both the verb's `findSession` (server.ts) and the local route. The alias map is persisted and is not cleared when a new session takes the channel. The residual is recorded under Under-block.
- (4) The bearer hop always sets `redact=device`.
- (5) `BearerReadRefused` marks an answered refusal as not unreachable.
- (6) Any `instarPrincipal` is refused; token auth sets none.
- (7) The first oversized piece is read through the continuation path.
- (8) A 403 refusal sentence passes through to the phone.
- (3) stays an open problem: the version constant must be checked at merge.
- Nit, not blocking: an all-digit `eventId` given as a continuation `row` is parsed to a number and would answer `row-gone`.

The findings below are the first pass, kept as written.

The safety floors were checked against the code, and they hold. No token is sent after a timeout or transport error: `signedThenBearer` catches a throw and returns before the bearer hop, and `MeshRpcClient.send` throws only on transport failure or timeout. `claim-unauthorized` permits the bearer hop only when the peer's version advert is absent or older than the minimum. A device principal is refused. The audience fails closed when the confined list or the team record cannot be read. Redaction runs before the clip and before the cut. `cutUtf8` keeps every cut on a character boundary and always moves forward. The offset-plus-index cursor reads every entry exactly once, including when the page cap falls inside a record and when one row is larger than the cap. The RBAC case is in the read/observe class, and the verb name matches FD-9. Mixed versions work in both directions: a local read without `full` has no byte cap, so an older asker gets record-boundary cursors. The concerns:

1. `src/server/routes.ts` (pool History route, about lines 21870-21925): the route reads no `row` or `byteFrom` query parameter. A cut history row therefore cannot be continued through HTTP. The CLAUDE.md text in `poolSignedReads.ts` says "history: the same page request with `row` and `byteFrom`", and spec §3d item 6 says "The routes pass the marker and the continuation through". Both claims are false for the route. `takeRows` also merges the cut piece into `messages` as if it were the whole row; the marker is only in `pool.truncated[]`. Separately, the merged page's next cursor does not use a truncated peer's own `oldest`, so rows that peer dropped can be skipped. Per the spec this needs a row of more than about 504 KiB, so it is mostly theoretical. Still, either the route should accept `row` and `byteFrom` and mark the cut row, or the CLAUDE.md text should be corrected.
2. `src/core/sessionTranscriptPull.ts:87-97` with `SessionManager.ts:8353`: `memoryPlaceInput` is recorded only when memory privacy is on (`planMemorySession` returns null when it is off). An app-conversation session spawned with privacy off therefore gets `conversations: []`, which is treated as "the owner's". That is fail-open, not fail-closed. The exposure is narrow: `refuseSpawn` blocks a confined spawn while privacy is off, so the remaining case is a session that ran before its conversation became private to someone else. The `extra` parameter that would carry the app key is never passed. Section 2 (Under-block) does not list this case.
3. `src/core/poolSignedReads.ts:28`: `SIGNED_POOL_READS_MIN_VERSION = '1.3.1740'` must equal the release that actually ships this change. Otherwise a peer between the two versions that answers `claim-unauthorized` gets no fallback. That direction is safe (a failure, not a token leak), and the artifact's Over-block section already names it. Restating it so the constant is checked at merge.
4. `routes.ts`, transcript bearer branch: `redact=device` is forwarded only when the caller asks for it, and the dashboard never asks. An older peer reached by bearer can therefore return its own token or PIN to the owner unredacted. The artifact's sentence "the serving machine removes its own API token and dashboard PIN" is true only for updated machines. Setting `redact=device` on every bearer hop would close this.
5. `routes.ts`, history bearer branch: "peer URL refused" and `HTTP 401` are thrown, so `viaBearer` marks them `unreachable: true`, and those machines appear in `asleepOrUnreachable` as if asleep. That mislabels exactly the F4 symptom ("token refused" or "peer URL refused" shown as asleep).
6. `routes.ts`, transcript route: the principal check is `kind === 'device'`, a denylist. Today `device-notify` is limited to its notify paths, so this cannot be reached, but an allowlist (owner only when the principal is `token` or absent) would fail closed for any future principal kind.
7. `sessionTranscriptPull.ts` (oversized path when `full` is off): `rowTruncated.totalBytes` is counted over the 4,000-character clipped text, but the continuation reads the full text, so the byte ranges disagree. This cannot happen at the 512 KiB cap; it shows up only with small test caps. Separately, the existing 4,000-character clip cuts by UTF-16 unit and can split a surrogate pair (this predates the change).
8. `mobileSessionControlsRoutes.ts:521-527`: a 403 audience refusal reaches the owner's phone as the generic "Can't read it", not the fixed FD-15 sentence. Minor.

None of these is a token-after-timeout path or a transcript shown to a member or guest. Items 1 and 2 are where the artifact claims more than the code does.

## Response to the second pass (builder)

1. Fixed. The pool History route takes `machine` + `row` + `byteFrom` (with the same page cursor) and returns the next range of that one row over the signed verb; the cut row carries `rowTruncated` on the row itself; when any machine stopped at the cap, rows older than its oldest returned row are left for the next page, so a caller paging by the oldest row it received skips nothing. Integration case added ("pool history: a row larger than the cap, through the route").
2. Fixed. The verb's `findSession` (server.ts) and the local route both add the app conversation key from the session's channel alias, the same lookup `conversationRefForSession` uses, so an app session spawned with memory privacy off names its conversation. Under-block now records the residual: a session whose record and alias name no conversation is the owner's (jobs, hand-started sessions, per the spec).
3. Kept, and named as Open problem 1 in `notes/ncb-3d-status.md`: the constant must equal the release that ships this; the safe direction (a reported failure, never a token) is unchanged.
4. Fixed. The bearer hop to an older machine always asks `redact=device`, so that machine removes its own token and PIN before the owner sees the text.
5. Fixed. A bearer read the machine answered and refused (`peer URL refused`, an HTTP status, an oversized answer, an old cursor) throws `BearerReadRefused` and is reported as a refusal, not listed in `asleepOrUnreachable`.
6. Fixed. The transcript route is an allowlist: only a request with no device principal of any kind is the owner.
7. Fixed. The oversized-row path reads its first piece exactly as a continuation does (whole text, redacted, then cut), so the ranges always agree. The surrogate-pair split in the existing 4,000-character clip predates this change; it is reported to the feedback queue, not changed here.
8. Fixed. The owner's phone shows the fixed refusal sentence for a 403.

9. (From the re-check, non-blocking) Fixed: a continuation `row` is matched as text, so an all-digit event id is found whether the route read it as a number or a string, and the marker echoes the row's own id.

**Under-block addendum:** a session whose record names no conversation and whose channel alias resolves to none is treated as the owner's, as the spec decides for jobs and hand-started sessions.

## Evidence pointers

- `tests/unit/sessionTranscriptPull.test.ts`, `tests/unit/topicHistoryPull.test.ts`, `tests/unit/session-transcript-reader.test.ts`
- `tests/integration/pool-reads-signed.test.ts`
- `tests/e2e/session-transcript-pull-alive.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
