# NCB slice 3c — status

**Slice:** native-conversation-base §3c, "A photo is readable on the machine that runs the session (F3)", items 1 to 7, plus the counters its maturation-plan rows read.
**Branch:** `echo/ncb-3c-media` (fresh off `origin/main` 3ae8208a6; the spec, its ELI16 and its convergence report copied in unchanged from `echo/native-conversation-base-spec`, PR #3086). Slice 3b (#3092) is not touched.
**PR:** https://github.com/JKHeadley/instar/pull/3099
**Local Verify:** requested on the Studio (`POST /local-verify {"pr":3099}`) at 19:57 PST 2026-11-11. **Not yet accepted:** every request from 19:57 to 21:59 (60 tries, every 2 minutes) answered `queue-full`; at 22:01 the queue held 12 PRs and 3099 was not among them. A detached retry (`~/echo-test-tmp-3c/lv-retry.sh` on the Studio, not tied to a session) asks every 2 minutes until 06:00 PST 2026-11-12 and stops at the first answer other than `queue-full`; every answer is logged in `~/echo-test-tmp-3c/lv-retry.log` on the Studio. If the log ends in `queue-full`, the request still needs to be made.
**Merged:** no (by instruction).

## What is built

- Trust rule by source: every path-tag form (`image`, `document`, `video`, `voice`, `file`) in person text becomes `[typed <kind>:` on the Telegram poller, the lifeline, the forward route, Slack (text, shared-file titles and contents, voice transcripts) and iMessage, before it is forwarded, queued or logged; the builder escapes again (idempotent).
- Producers and carriers: `media[]` by attachment id from the Telegram adapter, the lifeline (its own local path to 127.0.0.1 only, realpath-confined on receipt), and app files into a topic; carried by mesh `deliverMessage`, `SessionRouter`, the inbound queue (new nullable `media` column, guarded add-column; this machine's own download path kept only in its own queue and stripped before any send), live inject, respawn/spawn bootstraps, the owner side of a forward, the drain (built before `commitReceipt`), history text (`[photo]`, `[file: name]`) and message type.
- The fixed path-free sentence with the attachment id for older receivers; an older poller's message resolved by its own message id, its path discarded.
- `pending_media_events` with insert-then-look-again, idempotent conversion, the append listener, a start-up sweep and a 30 s sweep, the 300 s uncertain line (the wait continues), late events still inject, the sweep retries a "now available" line that found no running session (only after the row has stayed ready 90 s, so it never races a voice-transcript wait). Attachment-id waiters for app files whose message is still replicating.
- `GET /conversation-media/path` (Bearer + bind token, by platform message id or attachment id) and `GET /conversation-media/status` (waiters, event-lag p99, outcome counters `copied`/`local`/`copying`/`storedElsewhere`/`unavailable`/`converted`/`toldNotArrived`/`nowAvailableRetried` for the maturation row's kill criteria and graduation read).
- Lifeline-forwarded files are now captured into the media store (lifeline-owned agents such as Echo never captured them before, which is part of F3).
- CLAUDE.md section `### Telegram files on any machine` (template + `migrateClaudeMd`), CapabilityIndex entry `conversationMedia`; the capture-refusal degradation no longer says "The session still received it".

## Tests

Run on the M5 Pro (the Studio's single suite slot was taken for over 30 minutes), TMPDIR outside /tmp with no dots, umask 022, node 24, `--maxWorkers=4` (load per core under 1).

- Neighbour unit lane (git-diff selection + every migrate*/PostUpdateMigrator test + the new files): 392 files, 4108 passed, 0 failed. (An earlier Studio run of the same lane before the review fixes found 3 tests that encoded the old in-text path contract; they were updated.)
- Neighbour integration lane: 54 files, 549 passed, 0 failed.
- Neighbour e2e lane: 28 files, 119 of 121 passed before one test fix; then `app-media-cross-machine-alive` 2/2 passed (it needed the session bind token the production server requires). `test-agent-leak-guard-lifecycle` failed only because the lane's TMPDIR was outside the system temp folder; it passes 5/5 with the default TMPDIR. Not related to this change.

## Second-pass review

Independent subagent. First read raised four concerns: a Slack shared file's title could carry a live tag; a message held in this machine's own queue lost its download path (one-machine regression with native media off); an app file not yet replicated read "unavailable" with no retry; a voice line could be typed twice. All fixed with tests; re-check: "Concur with the review on all four fixes."

## Open problems

1. **Voice notes.** The spec's producer table lists voice. A Telegram voice note reaches the session as its transcript (now escaped) and the audio is deleted after transcription, as before, so it carries `media: []` and no file line. Nothing a session had is lost; giving the session the audio file would be new behaviour and was not built.
2. **Commit used the logged orphan-deferral override**, as 3b did: the lint flags 15 lines in the approved spec copied unchanged (deferrals that name their CMT ids inline but not in `<!-- tracked: -->` form, and fixed user strings containing "Follow up"). The spec owner should add the markers on #3086.
3. **Contract-evidence exemption.** `SlackAdapter.ts` and `imessage/inlineAttachments.ts` carry `CONTRACT-EVIDENCE: EXEMPT` with a reason (escaping only; no API surface changed), so no live Slack contract run was made.
4. **Sweep cadence.** The spec puts the reconciliation sweep in the existing periodic pending pass; that pass is hourly, which cannot serve a 300 s tell-time, so the sweep has its own 30 s timer (plus the start-up run).
5. **Cross-machine handoff not delivered.** Session echo-topic-141014 (M5 Pro) asked this session to relay an overlap note to echo-topic-141876 (Mama PC): "Justin approved closing #3082 for your 3a and dropping my outcome-route work for 3b (#3092). My remaining piece: token-less standby holds+retries a reply when the holder is unreachable (branch echo/standby-durable-forward-no-token; touches OriginForwardToHolder supersede, OriginMeshRelay). It must land after or with 3a." The relay (message 7e74d2a9) and the reply to the M5 (6e33adde) both sat queued: "no URL known for target machine" / "machine unreachable" (every pool machine shows a null URL here). A direct send was blocked by the messaging guard. Filed as feedback fb-693c7563-8e2. **3a's builder should read this note.** Slice 3c does not touch OriginForwardToHolder or OriginMeshRelay.
6. **Live proofs not run** (the spec's real-pool photo proof, the `[image:/etc/hostname]` proof, the throwaway pair with the serving machine on the previous release). They belong to the test-agent-live and dev-agent-live rungs before and on the release day.
