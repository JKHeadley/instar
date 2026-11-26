# Side-Effects Review — server voice transcripts as their own event

**Version / slug:** `voice-transcript-event`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `required` (first pass raised four concerns, fixed below; the re-check is pending)

## Summary of the change

Finishes docs/specs/mobile-native-chat-media.md §4.5.1 (evolution action ACT-179). A voice note the app sends without a phone transcript was already transcribed at dispatch through the shared `VoiceTranscription` module; the text reached only the session's line. Now the server transcript is stored as its own replicated `{kind: "transcript"}` event (`src/core/AppConversationStore.ts`: kind, validator, a `transcripts` index table picking one winner per attachment, `transcriptFor`), the replicated envelope knows its fields (`src/core/AppConversationsReplicatedStore.ts`: `attachmentId`, `provider`, `late`), and `AppConversationService` (`src/core/AppConversationService.ts`) scrubs it (inbound scan, then exact-token removal, cut with a note past 16,000 characters), stores it, runs at most one transcription per attachment per machine (`voice_transcriptions` rows in the media index, `src/core/AppMediaStore.ts`), and handles the late case: a transcript finishing after the 60 s dispatch deadline is stored `late: true` and produces one follow-up line (or a `transcript_notes` row the next delivery's context carries). Voice notes resolved through `[file now available]` are transcribed when they land. History and sync show the stored transcript on the attachment as `serverTranscript` (`src/server/mobileConversationRoutes.ts` `attachmentRows`). The production wiring (`src/server/AgentServer.ts`, `src/commands/server.ts`) raises the provider's own timeout to 10 minutes, names the provider, and connects the pairing service's `scanInbound`. The CLAUDE.md "App conversation media" voice line is updated in the template and refreshed in place by `PostUpdateMigrator`.

## Decision-point inventory

- `validateAppEvent` (event acceptance) — modify — accepts one new kind with strict field rules; every other kind unchanged.
- One-winner transcript index — add — earliest `at`, then lowest machine id. An invariant ordering, not a judgment.
- One-attempt-per-attachment ledger — add — a bound, not a competing-signals decision.
- Session line choice for a voice note — modify — stored transcript / running / recorded failure / pending after deadline. Enumerable states.

---

## 1. Over-block

No block/allow surface. Nothing is refused that was accepted before: a send, a dispatch and a history read behave as before. The one new refusal is a malformed `transcript` event in the validator, which only this change produces.

One deliberate narrowing: a voice note whose transcription failed once (including "no provider configured") is never transcribed again on that machine, even if a provider is configured later. That is the requested bound (one transcription per attachment, never retried in a loop). The audio stays readable.

---

## 2. Under-block

No block/allow surface. Gaps that remain, stated plainly:

- A transcript from a Telegram topic or Slack conversation continued from the app is stored, but no late follow-up line reaches those sessions (the follow-up injector only knows app conversation aliases; the same limit exists today for `[file now available]` there). The dispatch line says so ("saved with the message if it finishes") instead of promising a follow-up.
- Two machines can each transcribe the same attachment once (each holds its own attempt row). The index picks one winner deterministically, so every machine converges on the same text; the cost is at most one extra provider call per machine.
- Credential-shaped text in a server transcript is not removed (the phone-transcript path only flags it too). The session receives what was said.

---

## 3. Level-of-abstraction fit

The transcript is stored through the existing conversation store and replicated through the existing `appConversations` kind; no new store or transport. Scrubbing reuses `removeAuthorityTokens` and the pairing service's `scanInbound`, the same primitives the phone transcript path uses. The provider path is the existing `transcribeAudioFile` (no new provider). The late follow-up reuses the existing app follow-up injector and the pending-context path that `[file now available]` already uses.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It records and delivers text. The inbound scan it calls already exists and has the same authority as on the phone-transcript path (declining a pending pairing whose code was dictated).

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The winner rule is an ordering invariant (earliest, then machine id) chosen so arrival order cannot change the answer; the attempt ledger is a bound.

---

## 5. Interactions

- **Shadowing:** the server transcript never replaces a phone transcript: a voice attachment with `transcript` set is never sent to the provider (unit and integration tests assert it).
- **Double-fire:** two concurrent deliveries of the same attachment join one in-process transcription and arm one follow-up (unit test "two deliveries racing"). A redelivery after the transcript is stored reuses it. The follow-up and the next delivery's note are exclusive: a note is written only when the follow-up was not delivered, and is deleted once a delivery acknowledges it.
- **Races:** the attempt row is claimed with `INSERT OR IGNORE` before the provider starts. A process that dies mid-call leaves a `running` row, which the next look reads as a failure ("the server restarted before the transcript finished") and never re-runs. The late flag is set by the deadline before the transcription settles, so the stored `late` marker matches what the session was told.
- **Feedback loops:** none. A stored transcript does not trigger anything; replication of a transcript event from a peer only updates the index.
- **Signatures:** the transcript is a separate event; the signed `media-message` is never rewritten, so `verifyRecordedOrigin` sees exactly the record it saw before (unit test compares the stored record byte for byte; integration and E2E read `originVerified: "verified"` with a stored transcript present).

---

## 6. External surfaces

- **Provider:** the call is unchanged except that it may now run up to 10 minutes before it is aborted (was 60 s). Still one call per attachment per machine.
- **Other machines:** transcript events replicate. Older peers refuse the unknown kind and count it (`store-schema-rejected`), exactly as for `media-message`; nothing breaks there, they simply do not show the transcript.
- **The app:** history and sync rows for voice attachments may carry a new `serverTranscript` object. Sync also returns `transcript` events; the app already ignores kinds it does not render (delivery and purge events have always been in that stream).
- **Persistent state:** two small tables in the media index (`voice_transcriptions`, `transcript_notes`) and one in the conversation index (`transcripts`, derived and rebuildable). Bounded: notes expire after 7 days, finished attempt rows after 30 days.
- **Operator surface:** no operator-facing action added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Transcript events: replicated** through the existing `appConversations` replicated-store kind; every machine converges on the same winner.
- **Attempt ledger and late notes: machine-local by design.** The attempt row bounds this machine's own provider calls; the note is for this machine's session (the owner that delivered the message). Neither holds data another machine needs: the transcript itself replicates.
- **User-facing notices:** the follow-up line goes only to the conversation's session on the machine that owns the alias (`ownsAlias`), so one voice.
- **Durable state on transfer:** a moved conversation's new owner reads the replicated transcript; a pending late note stays with the old owner and expires after 7 days (the transcript is still in history).

---

## 8. Rollback cost

Pure code change: revert and ship a patch. After rollback, an older build refuses stored `transcript` events in its validator, so they read as absent (the session line and history fall back to the previous behavior); no migration needed. The three new tables are unused and harmless. The CLAUDE.md voice line would read slightly ahead of the code until the next refresh.

---

## Conclusion

The change stores what the server already produced, keeps it outside the signed record, bounds the provider to one call per attachment, and makes every failure visible as a plain reason. The review moved two things: the provider's own timeout (60 s made the late path impossible) and the platform-conversation line, which no longer promises a follow-up it cannot deliver. Clear to ship.

---

## Second-pass review

**Reviewer:** second-pass reviewer (via the coordinator)
**Independent read of the artifact: concern — fixed; re-check concurred (2026-11-03 03:24 PST)**

Concerns raised, and what was done:

- **Concurrency.** Nothing bounded how many provider calls one process could run at once; a burst of voice notes would start one call each. **Fixed:** a per-process limit of 3 provider calls (`VOICE_TRANSCRIBE_CONCURRENCY`, `limitedTranscribe` in `src/core/AppConversationService.ts`). Time spent queued counts toward the same 10-minute ceiling: a call still queued at the ceiling ends as "transcription unavailable: timed out waiting" and never reaches the provider; a running call is given only the remaining time (passed to the provider as its own timeout) and reads "the transcription service timed out" at the ceiling. A slot is held until the provider call itself settles, so at most 3 ever run. Tests: 8 notes fired at once peak at exactly 3 concurrent calls and all settle; with a limit of 1 and a 60 ms ceiling, the queued call times out waiting without a provider call and the running one times out, both recorded and not retried.
- **Peer transcripts.** Scrubbing ran only where this machine wrote the transcript; a peer that skipped it (an older or misbehaving build) could replicate a transcript carrying a `tlinv1:` invite or a `/desktop` code line straight to a session or the phone. **Fixed:** the exact-token removal (`transcriptForDelivery`, i.e. `removeAuthorityTokens`) now also runs on READ in every path that hands a stored transcript out: `transcription()` (the dispatch and "now available" lines), `pendingContext` (both the "now available" rows and the late notes), the late line, `serverTranscript` in history, and the `transcript` event's text in sync. Tests: a peer-authored transcript with an invite and a desktop line, stored as written, never reaches a session line, a pending-context line, history or sync unscrubbed (unit and integration).
- **Duplicate delivery.** With no live session, a "now available" row kept for the next delivery could carry the transcript AND a separate late note could say it again; and if the late line reached a live session after the row was kept, the row would repeat it later. **Fixed:** a late note is not written when a kept "now available" row will carry the transcript; `pendingContext` drops a note whose transcript a row already carries; a transcript that reached the session (late line or "now available" line) is marked `delivered`, and a kept row then shows only the file. Tests cover both directions.
- **This artifact.** Marked the second-pass reviewer `required` and added this section.

The re-check of these fixes by the second-pass reviewer is pending.

---

## Evidence pointers

- `tests/unit/app-voice-transcript-event.test.ts`
- `tests/unit/app-voice-transcription.test.ts` (deadline line updated)
- `tests/unit/PostUpdateMigrator-appMedia.test.ts` (voice line refresh)
- `tests/integration/mobile-native-media.test.ts` ("server voice transcripts (§4.5.1)")
- `tests/e2e/mobile-native-media-alive.test.ts` ("server voice transcripts (§4.5.1) on the production path")

---

## Class-Closure Declaration

No agent-authored-artifact defect is fixed here. For the `unbounded-self-action` class: **guard.** The one self-triggered action this adds is the late-transcript follow-up line (a notify); provider calls are additionally capped at 3 concurrent per process, with queue time counted toward the 10-minute ceiling. It fires at most once per attachment per machine, from a transcription that itself runs at most once per attachment per machine: the `voice_transcriptions` row is claimed before the provider starts and is never reset to allow a retry (a `running` row left by a crash is read as a failure), the in-process entry arms the follow-up exactly once (`lateArmed`), and an undelivered line is one `transcript_notes` row keyed by attachment id (`INSERT OR IGNORE`) that a delivery acknowledges or the 7-day expiry removes. Steady state under sustained pressure (no live session, provider always slow) is therefore one line per voice note and zero further actions. `defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: {enforcementType: ratchet, citation: tests/unit/app-voice-transcript-event.test.ts ("two deliveries racing one slow transcription start the provider once and send one follow-up"; "a failure is recorded with its reason and never retried"; "a run a restart interrupted reads as a failure"), howCaught: an unbounded retry or a repeated follow-up would raise the provider call count above 1 or the follow-up count above 1 and fail these assertions}`. The file is not a controller-shape file and `scripts/lint-no-unregistered-self-action.js` reports nothing for it.

Reviewer re-check (2026-11-03 03:24 PST): Concur with the review. All four concerns are fixed. Residual note: the new `delivered` column exists only in CREATE TABLE IF NOT EXISTS; a machine that ran an earlier build of this unreleased branch keeps the old table, and its caught write failure can repeat a transcript once. Nothing released has this table.
