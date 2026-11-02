# Side-Effects Review — media in app conversations, increment 1 (this machine's half)

**Version / slug:** `mobile-native-chat-media-inc1`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent, second pass, 2026-11-01 (concern; findings fixed, confirming pass pending)`

## Summary of the change

Builds the first part of increment 1 of `docs/specs/mobile-native-chat-media.md` (converged, approved): the Instar iPhone app can upload photos, videos, voice notes and files into a native app conversation and the agent can reply with files. New: the `media-message` and `purge` event kinds (`AppConversationStore`, with an incrementally kept reference-count table for admission), a content-addressed blob store with resumable signed-chunk uploads, crash recovery, expiry, orphan reclaim, integrity checks, quarantine and session copies (`AppMediaStore`, `appMediaWorker` for all hashing/assembly off the event loop), the device routes (`mobileMediaRoutes.ts`: start, chunk, resume, download, purge), attachments on `POST /mobile/chat/app/:key` (preflight, size check, atomic claim, publish, persist), session lines in Telegram's forms and lazy history lines (`appInboundDispatch`), `GET /app/media-path/:attachmentId` and the `app-media-path` helper, `app-reply.sh --file` with the reply-file checks (`appMediaReplyFiles.ts`), the signed-record attachment check and the `instar-app-redaction-v2` payload (`AppRecordSignatures`), per-attachment `bytes` facts, the device allowlist's body types, the chunk route's own 240/min bucket and the replay guard's send reserve (`mobilePairingRoutes.ts`, `MobileDeviceKeys.ts`), `/health` → `appMedia`, capacity notices, the dev gate `mobilePairing.native.media.enabled`, registries (state coherence, write domain, capability index, Spotlight, file classifier), the CLAUDE.md section with its migration, and the helper's install in all four places. Tier 2, about 1,900 lines of source and 1,300 of tests; the spec converged in 6 rounds before this build; no review rounds yet in this build.

**Not in this PR (the rest of increment 1, then increments 2–5):** copying bytes between machines (`app-media-pull`, eager pull with brakes, inventories, `singleCopyBlobs`, owner pull before dispatch, the "still copying"/"now available" lines, `202 fetching` on download) and the pool merge of `appMedia` in `/health?scope=pool`. Until then a file on another machine reads `bytes: "not-here"` and the download answers `404 media-unavailable` with a plain reason; `singleCopyBlobs` and `unrecoverableBlobs` read `null` (never 0). The feature is dev-gated, so this gap exists only on development agents.

## Decision-point inventory

- File type and effective kind — add — fixed magic-byte table; a mismatch reclassifies to `file`, never refuses.
- Inline vs attachment serving — add — sniff table types inline, everything else `application/octet-stream` + `attachment`, always `nosniff` + sandbox CSP.
- Download authorization — add — device active now (ledger revocation included) and a hash referenced by an unpurged attachment of the named live conversation; otherwise the same 404.
- Size, count, staging, admission cap, disk floor — add — fixed numbers and hashes, no content.
- Reply file path — add — three roots, never-served list, credential-path components, `O_NOFOLLOW` + inode match, hard-link refusal.
- Live-credential wall on reply files — pass-through — the existing `detectOutboundCredential` applied to each snapshot's printable runs.
- Device allowlist body types and buckets — modify — each rule names its body type (415 otherwise); chunks have their own bucket.
- Replay guard — modify — non-send requests stop at 1,900 of the 2,000 entries.
- Signed-record verdict — modify — media records also compare the signed attachment fields; redacted media use payload v2.
- Purge — add — operator device request on tombstoned native or platform conversations; removes only blobs no unpurged attachment references.
- Telegram send route — modify — a body with `attachments` is refused with 400 `media-target-unsupported` (never stored without its files).

---

## 1. Over-block

- **A file over 50 MiB, a message over 64 MiB or 10 files, a reply over the same** — refused with 413 by design (spec limits).
- **Upload concurrency:** at most 4 uploads still receiving chunks per device. The spec says "4 open uploads"; read literally (counting finished-but-unsent uploads) a 10-file message could never be sent, so "open" here means `open`/`assembling`. Finished uploads still count toward the 256 MiB per-device staging bound. Recorded as an interpretation.
- **Staging is counted at declared size**, an upper bound on the final file; the brief moment when chunks and the assembled copy coexist is not double-counted.
- **Reply files:** a file outside the project, the outbox and the temporary directory is refused (an agent that keeps files elsewhere must copy them to the outbox). Any `.claude*`/`.codex*`/`.instar` path component inside an allowed root is refused, including ordinary files such as `.claude/skills/x/SKILL.md`; the denylist is deliberately coarse. A hard-linked file is refused even when harmless.
- **The credential wall on binary files** can refuse a binary whose printable run happens to match a provider-prefixed key shape (e.g. a test fixture). The wall only matches provider-prefixed value shapes, so this is rare; the agent can remove the value and resend. Non-overridable by design (the existing wall's rule).
- **A misdeclared file** is never refused; it is delivered as `file`.

## 2. Under-block

- **Deliberate exfiltration** by a session that packs a key into an archive or encrypted file in an allowed root is not caught (compressed/encrypted contents cannot be inspected). Stated in the spec, the CLAUDE.md section and here; the recipient is the operator's own paired phone.
- **A credential split across a non-printable byte** in a binary file is split into two runs and not matched.
- **The admission cap is soft across machines** (spec §4.7): another machine's admissions count only after their events replicate. The per-machine disk floor is the hard protection.
- **Blob tampering by the agent's own OS user** is detected (hourly on changed mtime/size, weekly in full) and quarantined, not prevented.

### Declared limits (second-pass review, item 6; no code change)

- **Reply-file parent-directory race.** The reply check resolves the path with `realpath`, then opens the file with `O_NOFOLLOW` and compares the descriptor's device and inode with the checked `stat`. `O_NOFOLLOW` covers only the last path component: a process that swaps a *parent* directory for a symlink between the `realpath` and the `open` can make the open reach a file outside the allowed roots, as long as that file is not itself a symlink and has one link. Only a process running as the agent's own OS user can do this, which is the session itself; the spec already states a session that sets out to send a file is not contained (§4.6, mobile-device-keys §2.2). Not closed here.
- **Deleting a conversation does not free disk.** A tombstone moves the conversation's blobs to `app-media/deleted/`, which frees capacity under the cap but not disk space; only the operator's purge frees disk (spec §4.7). A machine below the disk floor stays there until files are purged, the disk is cleared, or the floor notice is acted on.
- **Media off still builds the store and runs the sweep.** With `mobilePairing.native.media.enabled` off but native conversations on, `AppMediaStore` is still constructed and the hourly sweep still runs (expiry, purge application, orphan reclaim, integrity checks) over whatever is stored, so switching media off never strands a copy and a purge still completes. With nothing stored the sweep does no work.
- **Flag read at different times.** The device routes and the send route read the flag once at boot; `POST /app/session-reply` (agent replies with `--file`) reads it per request. After a config edit without a restart the two disagree until the next boot: the agent can be refused (or allowed) to send files while the phone routes keep the boot-time setting. Both directions refuse or allow only this feature's own actions.

## 3. Level-of-abstraction fit

Byte handling sits in one store (`AppMediaStore`) below the routes; the routes keep the existing send order of mobile-native-conversations §4.2 and add the claim/publish steps between reservation and persist. Hashing, assembly, snapshots and printable-run extraction run in short-lived worker threads (`appMediaWorker`), so a 50 MiB file never blocks the event loop. The reply-file credential check reuses the existing outbound credential wall instead of adding a detector. Usage for the cap lives in the conversation store's derived index, next to the events it is derived from, so it is rebuilt with them.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface **of judgment**: every refusal is a fixed invariant (sizes, counts, hashes, path roots and components, device status, a fixed type table).
- [x] The one content-based refusal is the existing live-credential wall (`detectOutboundCredential`, `HARD_WALL_CREDENTIAL_KINDS`), applied to a file's text. This adds no new kind and no heuristic; it routes files through the existing wall instead of around it. That wall's authority is the documented exemption (hard-invariant validation / safety guard on an irreversible action), as the spec's decision table records (ACT-027 tracks the registry wording conflict).

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Every decision listed above is an invariant (enumerable domain) or a safety guard on an irreversible action (sending a credential, deleting bytes), as declared in the spec's `## Decision points touched` table.

---

## 5. Interactions

- **Shadowing:** the media checks run inside the existing send handler after the request-id lookup and the emergency-stop check; an exact emergency stop with attachments is handled as text (its uploads simply expire), so media checks can never delay a stop. The reply route runs the file checks before the tone gate; a refused file means the tone gate never runs for that reply (the reply is not sent either way).
- **Double-fire:** the sentinel now classifies the caption plus phone transcripts (a dictated "stop everything" is still seen); a media message with neither skips classification.
- **Races:** the claim is one SQLite transaction (`complete → claimed`); a second request naming the same upload gets 409. Claim recovery runs only for claims not running in this process and older than 5 minutes. `finalizeUpload` is serialized per upload. Concurrent starts of one new file reserve its bytes once.
- **Replay guard:** non-send requests (reads, chunks) can now be refused at 1,900 entries instead of 2,000; sends keep the full bound.
- **Feedback loops:** a capacity refusal triggers one self-heal sweep (at most every 5 minutes); the notice is raised only if the condition persists after it.

## 6. External surfaces

- **Phones:** new device routes, new `attachments` and `bytes` fields in history and sync responses (never a server path), new 4xx/5xx codes. A 415 now also answers an `application/octet-stream` body on a JSON route (was a JSON parse of nothing) and any body on the two no-body GET routes.
- **Sessions:** new tag lines `[image:…]`, `[document:…]`, `[video:…]`, `[voice:…]`, a changed context-file rule line, a new helper script, and `app-reply.sh --file`. `app-reply.sh` changed bytes; its prior hash is on the replaceable list and the blocking-decision baseline is re-declared (still non-blocking: every decision is the server's).
- **Persistent state:** `<stateDir>/app-media/` (blobs, deleted, quarantine, uploads + index.sqlite, session-files, outbox), four new tables in the conversation index (derived, rebuilt with it).
- **Telegram:** none in this increment (a Telegram send with attachments is refused). Capacity notices go through the existing attention path when Telegram is configured; without it they are degradation reports only.
- **Operator surface (Mobile-Complete):** the only operator action is the purge, which is a device-signed request from the app's Storage screen (increment 5 builds the screen); no PIN or approval route was added.

## 6b. Operator-surface quality

No operator surface (no dashboard or approval page) — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- `media-message` and `purge` events: **replicated** through the existing `appConversations` kind (`knownFields` gains `attachments`, `attachmentIds`; a round-trip test asserts nothing is dropped). An older peer refuses `media-message` at validation (counted), never stores it without its files.
- Admission usage: **derived from the replicated events** on every machine (soft cap, stated in the spec).
- Blobs: **machine-local in this PR** — the verified pull that unifies them across machines is the rest of increment 1 (not built here). This is the known gap of this PR: a file sent to one machine is not readable from another until it ships. A phone talks to the machine that holds its device record, and only the serving-lease holder dispatches, so on one machine (and on the paired machine of a pool) the flow is whole.
- Upload sessions and staged chunks: **machine-local by design** (physical-credential-locality: the phone's device record is bound to this machine).
- Session copies: per-machine cache derived from blobs, re-created on demand.
- `/health` `appMedia`: per machine; the pool merge ships with the pull.
- User-facing notices: the capacity notices are per condition (`app-media:store-full`, `app-media:disk-floor:<machineId>`), deduplicated by condition key. No URLs are generated.

## 8. Rollback cost

Switch `mobilePairing.native.media.enabled` off: the media routes answer 503, sends with attachments 400, `--file` 503; blobs and events stay on disk and the purge route keeps working. A code revert leaves `app-media/` and the four index tables unused (the index is derived; a revert-era index ignores them). `media-message` events written by this version would be refused by a reverted version's validator and skipped at index catch-up (reported once per line, left in place), so a revert hides media messages but loses nothing; reinstalling restores them. Dark on the fleet, so no fleet user sees a rollback.

---

## Conclusion

The review kept the feature's refusals to fixed invariants plus the existing credential wall. Changes made during the build because of findings: an upload's stored filename is blanked when the upload is sent or expires (a removed invite in a filename would otherwise have stayed in the upload index); the safe file name never keeps the sender's extension (an `x.html` sent as a file would have been offered as `x.html`); the attachment check orders "already sent" before the field comparison; "open uploads" means uploads still receiving chunks (otherwise a 10-file message is impossible). Process note: the first merge of origin/main into this branch was committed with git hooks disabled; it was reset and redone with hooks on before anything was pushed. The cross-machine half of increment 1 is the next PR. A second-pass review is required (inbound dispatch, a credential wall on a new input, device authentication) and has not been run.

---

## Second-pass review (if required)

**Reviewer:** independent subagent, second pass, 2026-11-01
**Confirming pass, 2026-11-02 00:33: concur.** The same reviewer re-read fixes 1-4 in commit 3da3c3eae and agreed; finding 5 and item 6 stay declared. The piped-caption follow-up (dd2cb9d75) answers its one suggestion.

**Independent read of the artifact: concern** (the first pass; the findings below were each checked against the code and fixed in this change).

- **Data loss: a purge in the send gap could delete a deduplicated blob.** `applyReferences` removed a blob once every reference was purged, without checking uploads still in flight, while the send path awaited a re-hash between claiming and publishing. Fixed: a hash named by an upload that is open, assembling, complete or claimed is never removed, and the send now hashes first (`verifyClaimed`, async) and then publishes and appends with no await between them (`publishVerified` then `append`). Test: a purge pass run between verify and publish leaves the blob in place, and it survives the event landing.
- **An upload expired during assembly could come back as complete.** The finish update is now conditional on `state = 'assembling'`; an upload expired meanwhile stays expired and cannot be claimed. Test with the expiry landing while the worker hashes.
- **A stale quarantine blocked a later good copy.** The download route and the byte fact now prefer a held, checked copy over a quarantined one, and publishing a verified copy renames the quarantined file aside (kept as `<sha>.superseded-<ms>`, never deleted). Test: quarantine, then a fresh upload of the same bytes reads `verified`.
- **Inline types and control characters.** `isInlineSafe` is an exact allowlist equal to the sniff table (no SVG or other media-looking types); replicated attachments with a control character (CR and LF included) in the type or file name are refused, the upload start refuses them, and reply file names have them replaced. Tests for each.
- **File names on replies.** File names go through the live-credential detector; a reply with files and no caption runs the outbound check on the file names. `app-reply.sh --file` with no text argument reads stdin only with a bounded wait (see the confirming pass below), so a stdin that never closes cannot hang it. Tests: a key in a file name is refused; the script returns with an open stdin.
- **Declared, no code change:** the four limits under "Declared limits" in section 2.
- **Confirming pass: concur**, with one follow-up, done in this change: making `--file` ignore stdin silently dropped a piped caption (`cat <<'EOF' | app-reply.sh --file x`). The script now reads a non-terminal stdin with a bounded wait (`read -t 2` per line, 10 s in all), sends what arrived, and warns on stderr when it stopped waiting part way; a timeout is recognised both by bash 4+'s status above 128 and, on macOS's bash 3.2 (which returns 1), by the read taking the full 2 s. A text argument is still the caption and stdin is then not read. Tested against a stand-in server on bash 3.2 (the only bash on this machine): a heredoc caption arrives whole, a last line with no newline is kept, a never-closed stdin returns in about 2 s with no caption, a stalled pipe sends the first line with the warning.

## Suite ratchets settled in this change (Zero-Failure)

The full Local Verify of 3b3fc747d failed three unit ratchets, all from this PR and none a logic change: `SqliteRegistry-wiring` (the media upload index is now on its list of registered stores), `no-empty-catch-blocks` (the inline worker's directory fsync catch now has a body), and `no-silent-fallbacks` (three catch blocks whose scan window grew to include this PR's code already report through `deps.reportDegradation`; they now say so with `@silent-fallback-ok`).

---

## Evidence pointers

- `tests/unit/self-action-convergence.test.ts` (controller `app-media-capacity-notice`), `tests/unit/app-media-types.test.ts`, `tests/unit/app-media-store.test.ts`, `tests/unit/app-media-reply-files.test.ts`, `tests/unit/PostUpdateMigrator-appMedia.test.ts`
- `tests/integration/mobile-native-media.test.ts` (30 tests), `tests/e2e/mobile-native-media-alive.test.ts`

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (the hourly media sweep raises a capacity notice on its own).
- **`closure`** — `guard`.
- **`guardEvidence`** — `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (controller app-media-capacity-notice, src/testing/selfActionRegistry.ts), howCaught: under a store that stays full forever the notice is raised once per episode (the raisedNotices latch refuses every later raise and only the condition clearing re-arms it), so the action count is 1 at any horizon}`. The latch is also tested on the real service (`tests/unit/app-media-store.test.ts`, "capacity notices"). The sweep's other actions are terminal per item (an orphan blob is removed once, after 7 days; an expired upload once) and never re-trigger the sweep.
