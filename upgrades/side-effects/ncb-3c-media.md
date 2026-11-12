# Side-Effects Review — media by attachment id through every carrier (native-conversation-base slice 3c)

**Version / slug:** `ncb-3c-media`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `independent general-purpose subagent (see below)`

## Summary of the change

Tier 2 (spec `docs/specs/native-conversation-base.md`, converged in 6 rounds and approved; this PR builds slice 3c only). 18 source files changed or added (3 new modules), 8 test files new or changed across all three tiers. One build pass; spec review rounds belong to the spec.

F3: a Telegram photo stayed on the polling machine, and the session on another machine was told to read `[image:<path>]` for a path that only exists on the poller. Worse, the injector turned any `[image:…]` / `[document:…]` in the text into "read the file at <path>", so anyone who can post in a conversation could point the session at any readable file (also on Slack and iMessage).

- `src/core/inboundMedia.ts` (new, pure): `escapeTypedPathTags` (every `image`/`document`/`video`/`voice`/`file` tag form in person text becomes `[typed <kind>:`, matched by no injector pattern old or new; idempotent); the fixed path-free fallback sentence; `composeInboundPayload` / `stripFallbackSentences`; `parseInboundMediaField` (closed kinds, id patterns, never a path; `null` = older sender, `[]` = newer sender with no file); `takeLeadingLegacyTag` (position 0 only); `historyTextFor` (`[photo]`, `[file: <name>]`, `[video]`, `[voice note]`); `messageTypeOf` (from the field, never from text).
- `src/core/platformMediaForSession.ts` (new): `PlatformMediaForSession.buildInboundSessionText` builds the session's file lines on the serving machine with no network wait: event and blob here → the app's own `sessionLinesFor` (private copy, confined inbox, voice transcript); event here, blob not → `[file still copying]` + `pending_deliveries` + pull; no event yet → the same line + a `pending_media_events` waiter (insert, then look again); capture off or media off here → this machine's own download (realpath-confined to the download directories) or "stored on another machine". The waiter table (in the media index DB, created idempotently), idempotent `convertPendingMediaEvent` (only the transaction that set `convertedAt` goes on; a blob already here is delivered at once through `resolvePending`), the append listener, and the reconciliation sweep (at start and every 30 s): converts, tells a session once at 300 s with uncertain wording and keeps waiting, retries a "now available" line for a Telegram key that found no running session (deletes the row only after the line was typed), ends waiters at the 7-day pending TTL. `buildTelegramSessionText` serializes one topic's builds so a photo and the text after it reach the session in order. Counters for the maturation row.
- `src/server/forwardedInboundMedia.ts` (new): the `/internal/telegram-forward` side. A local path is taken only from a lifeline-proven forward, realpath-checked inside `<stateDir>/telegram-images|telegram-documents`; an older lifeline's tag is read only at position 0; an app file arrives by attachment id.
- `src/messaging/TelegramAdapter.ts`: photo and document messages carry `metadata.media` (in-process `localPath`) and path-free text; text and voice transcripts are escaped; every message carries `media` (empty for text); history rows carry the `[photo]` form; `captureForwardedMedia` captures a lifeline-downloaded file into the media store like a polled one (lifeline-owned agents never captured before).
- `src/lifeline/TelegramLifeline.ts`: typed text and captions escaped before forward or queue; its own photo/document sent in `media` (with its local path, to 127.0.0.1 only); the leading tag kept for an older server; a queue replay carries no `media`, so the server reads the position-0 tag as for an older lifeline.
- `src/server/routes.ts`: the forward route normalizes once (text becomes sentences + escaped person text before anything is logged, forwarded or queued), logs the history form, sets `metadata.media`, captures lifeline files, accepts a files-only app message; its fallback inject and bootstrap use the builder. New `GET /conversation-media/path` (Bearer + bind token where bind auth runs; by platform message id or attachment id; checks the attachment belongs to the conversation and is not purged; waits `MEDIA_PATH_WAIT_MS`; confined path or `not-on-this-machine` with the reason) and `GET /conversation-media/status`.
- `src/server/mobilePairingRoutes.ts`: an app file into a Telegram topic passes `media: [{kind, attachmentId, filename}]` instead of tag lines in text.
- Carriers: `SessionRouter` (`InboundMessage.media`, both `deliverMessage` sends), `MeshRpc` (`deliverMessage.media`), `server.ts` (live path: router, three queue custody sites, local inject, respawn and spawn bootstraps built once on the serving machine; owner side of a forward: built from the validated `media`; the drain: built before `commitReceipt`), `QueueDrainLoop` / `PendingInboundStore` (nullable `media TEXT` column added with the guarded add-column form; stored, cleared at terminal; an unreadable cell never poisons a row).
- `src/core/AppConversationService.ts`: `setPlatformFollowUp`, the second injector in `resolvePending` for `telegram:<topicId>` keys.
- `src/messaging/slack/SlackAdapter.ts`, `src/messaging/imessage/inlineAttachments.ts` (extracted from `server.ts`): typed tags escaped at the adapter before its own tags are added (FD-12); Slack data and placement untouched.
- `src/server/AgentServer.ts`: builds and starts the resolver where the Telegram media hook is wired; the capture-refusal degradation no longer says "The session still received it".
- `CapabilityIndex` entry `conversationMedia`; CLAUDE.md section `### Telegram files on any machine` (template + `migrateClaudeMd`, by exact heading).

## Decision-point inventory

- "Text is never a path" — add — invariant (spec Decision points: irreversible-consequence). Escaping is unconditional for person text on Telegram, the lifeline, Slack and iMessage.
- "No network wait before injection" — preserve — the builder reads local stores only; `sessionLinesFor` is called with a 0 ms pull wait.
- "Tell the session at 300 s" — add — judgment-candidate with the spec's floor (uncertain wording, the wait continues, a late file still produces its line, the fetch route stays) and the 2026-11-25 review as arbiter; event lag is recorded (`lagP99Ms`).
- "Accept a local path from a forward" — add — only a lifeline-proven forward, realpath inside the download directories.

---

## 1. Over-block

- A person who really writes `[image:…]` as text (quoting a log, say) now reaches the session as `[typed image:…]`. That is the intended trust rule; nothing is dropped.
- With native media off on a non-polling machine, a session that used to get a (dead) path now gets "The user sent a file that is stored on another machine and cannot be opened here." Correct by F3.
- In a mixed-version window, a tag a person types into a message forwarded by an older poller is read as "a file that has not arrived" (the spec's stated limit) and gets the 300 s line; it never becomes a path.
- An older lifeline still reads a typed tag at position 0 of a plain text message as a file, confined to the download directories, until it restarts on the new build (spec Left behind 7).

## 2. Under-block

- Lines the server types later (`[file now available: <path>]`) go through `injectMessage`, not the escaper; a person can type that text and it is not escaped (spec Left behind 18, marked server lines). It is not turned into a read instruction by any injector.
- A shared file's title and a voice transcript are person text too; both are escaped on Slack (second-pass finding 1).
- Voice notes stay as before: the transcript is the content (now escaped) and the downloaded audio is deleted after transcription, so a voice note carries `media: []` and no file line. The spec's producer table names voice; a voice note's audio has never reached a session, so no file line is lost. Noted as an open item in the status note.
- `capture: 'pending'` on the poller means "copy started", not "copy succeeded"; a refused capture looks like a slow event and gets the uncertain 300 s line. That is the spec's choice (no definite wording); the re-capture sweep is CMT-049.

## 3. Level-of-abstraction fit

One builder at the one seam every carrier reaches (live inject, bootstrap, owner side of a forward, drain, the route's fallback). The wire carries ids only; paths exist only on the machine that made them. Resolution reuses the app media resolver (`sessionLinesFor`, `resolvePending`, `pending_deliveries`, the replicator) instead of a parallel copy path; the only new table is the event waiter the spec requires because `pending_deliveries` needs a hash.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over messages.

Escaping rewrites four characters of a tag; it never drops, holds or refuses a message. The resolver never blocks delivery: every branch returns a line and the message is injected at once (FD-8). The 300 s line is a signal to the session, which decides (fetch, wait, ask).

## 4b. Judgment-point check

The only threshold added is the 300 s tell-time, inherited from `recoverableLatencyCeiling` and declared a judgment-candidate with floor and arbiter in the spec; the measured lag the review needs is recorded (`/conversation-media/status`). The 30 s sweep interval is a cadence, not a decision.

---

## 5. Interactions

- **Ordering:** builds are serialized per topic (`buildTelegramSessionText`), and each caller injects synchronously when its build resolves, so a photo and the following text keep their order (e2e). The drain builds before `commitReceipt`, so receipt-then-inject stays adjacent; it re-checks the spawn guard after the build.
- **Double-fire:** conversion is claimed by `UPDATE … WHERE convertedAt IS NULL`; delivery is claimed by `resolvePending`'s `UPDATE … state='waiting'`; the sweep's retry deletes a `ready` row only after the line was typed. Listener + sweep give one line (unit tests).
- **SessionManager dedupe and transforms:** unchanged. The builder emits the same `[image:<path>]` / `[document:<path>]` forms the injector already turns into read instructions; person text can no longer produce them.
- **Sentinel / commands / pairing-invite / desktop checks** on the forward route now see the escaped, sentence-prefixed text. Commands are unaffected (a photo caption was never a command: it always followed a tag). The emergency-stop app path sends `media: []` and the bare text (integration test unchanged and green).
- **App conversations:** `resolvePending` keeps its app branch; the Telegram branch runs only for `telegram:` keys with no app alias.
- **Memory privacy:** `registerMemoryInboundFile` still receives the in-process download path; `moveInboundFilesIntoScope` handles server-built paths as before.

## 6. External surfaces

- Other machines: `deliverMessage` gains an optional `media` (ids only). An older receiver ignores it and injects the path-free sentence, so its session knows a photo was sent and its id (integration test). An older sender sends no `media`; a new receiver resolves by the platform message id and discards the path.
- Sessions: new line forms (`[file still copying: …]`, `[file now available: …]` for Telegram topics, the 300 s line, "stored on another machine"), typed tags shown as `[typed …:`, and the fetch route. CLAUDE.md section tells them.
- Persistent state: one nullable column on the inbound queue, one table in the media index DB; both created idempotently at open. Topic history rows written from now on carry `[photo]` forms instead of paths (device text was already path-free).
- The lifeline → server request gains `media` (local hop only).
- Timing: a photo message's inject now awaits a local file copy (as the app path always did); no network wait.

## 6b. Operator-surface quality

No operator surface. `GET /conversation-media/status` is a read for the agent and the review.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Media events and bytes: **unified** (the existing replicated store and pull-by-hash), now also fed by lifeline-forwarded files.
- `pending_media_events` and `pending_deliveries` rows, session copies, confined paths: **machine-local by design** — a derived per-machine work queue for copying unified data onto this disk (spec Multi-machine posture). When a topic's session moves, the new machine has no row; the session holds the attachment id and uses the fetch route (spec Left behind 29, CMT-049).
- Status counters on `/conversation-media/status`: per machine, read per machine at the review.
- Notices: none to users. Generated URLs: none (the route is localhost).

## 8. Rollback cost

By version, no data repair. A downgraded receiver ignores `media` and injects the sentence (truthful); a downgraded queue ignores the `media` column and drains the payload's sentence; the waiter table is ignored. Items 4 to 7 can be switched off per machine with the existing media switch (`mobilePairing.native.media.enabled`): the session is then told the file is on another machine, or given this machine's own download.

## Conclusion

The slice builds §3c items 1 to 7 and the maturation counters. Clear to ship once the second pass concurs.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (fresh context; read the diff, spec §3c and this artifact).

**First read: four concerns raised, all fixed in this PR.**

1. *(high)* A Slack shared file's title (sender-set) was inserted raw into `[User shared "<title>"]`, so a title like `x][image:/…/.ssh/id_ed25519` produced a live tag the Slack bootstrap transform turns into a read instruction. Fixed: the title and Slack voice transcripts pass `escapeTypedPathTags` (`SlackAdapter.ts`); test in `inbound-media-carriers.test.ts`.
2. *(medium-high)* A photo that waited in this machine's own inbound queue lost its download path (the queue stored the wire form), so on a one-machine agent with native media off it read "stored on another machine". Fixed: the queue and the router receive the local form; `SessionRouter`'s two `deliverMessage` sends and the spawn hop strip it with `toWireMedia`; the drain reads the cell with `parseQueuedMediaCell` (keeps `localPath`, never used on wire input); the resolver still accepts it only realpath-confined to the download directories. Test: "a message held in this machine's own queue keeps its download". (Custody transfer moves the delivery ledger, not queue rows, so the path never leaves the machine.)
3. *(medium)* An app file into a topic, served on a peer before its message event replicated, read `[file unavailable]` with no retry. Fixed: a missing reference is pending; attachment ids get `att:<id>` waiters, converted by the listener on `media-message` appends and by the sweep; the 300 s line names `attachmentId=`. Test added.
4. *(low-medium)* The sweep's `ready`-row retry could race `resolvePending`'s 60 s voice-transcript wait and type a second line. Fixed: the sweep retries a row only after it has stayed `ready` for 90 s (`READY_RETRY_SETTLE_MS`). Test updated.

It concurred on the trust rule at every entry point, the carriers, ordering, conversion idempotence and the app path.

**Re-check (same reviewer, after the fixes): "Concur with the review on all four fixes."** It confirmed every queue/router entry passes the local form, every peer send strips it (both `SessionRouter` sends and both mesh senders), only `QueueDrainLoop.toMsg` reads the stored path back, peer input still goes through the wire parse, and the 90 s settle is always longer than `resolvePending`'s voice wait.

## Evidence pointers

- `tests/unit/inbound-media.test.ts`: every tag kind escaped, in a caption and alone, run through the previous release's injector patterns; idempotence; fallback sentence; field parsing; history and type.
- `tests/unit/platform-media-for-session.test.ts`: event+blob; blob late; event after the message; blob already here when the event lands; event between first look and insert; restart healed by the start-up sweep; double conversion gives one line; 300 s line once, row kept, late event still "now available"; no session then a session; capture off; media off; older poller; pre-column queue row.
- `tests/unit/forwarded-inbound-media.test.ts`, `tests/unit/inbound-media-carriers.test.ts`: lifeline confinement and position-0 rule; Slack and iMessage escapes; Telegram adapter producer; lifeline body; queue column migration.
- `tests/unit/PostUpdateMigrator-telegramFiles.test.ts`: template and migration, once, with the agent's port.
- `tests/integration/conversation-media-path.test.ts`, `tests/integration/mobile-media-to-platform.test.ts`: the route (both ids, 404 other conversation, 403 without token), the forward route, both mixed-version directions, the app photo into a topic.
- `tests/e2e/app-media-cross-machine-alive.test.ts`: two AgentServers on the production path; B injects at once with the copying line, then exactly one "now available" after the blob crosses the signed mesh; photo then text in order; the route and status answer 200.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
