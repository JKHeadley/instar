# Side-Effects Review — media in app conversations, increment 2 (server voice transcription)

**Version / slug:** `mobile-native-chat-media-voice`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not run (Tier 1, narrow reuse; the build brief did not require one)`

## Summary of the change

Implements the dispatch half of `docs/specs/mobile-native-chat-media.md` §4.5.1 (increment 2, converged and approved): a voice attachment in a native app conversation that arrives without a phone transcript is transcribed by the server before the session line is built, reusing the Telegram transcriber.

- New `src/core/VoiceTranscription.ts`: `resolveTranscriptionProvider` and `transcribeAudioFile`, moved out of `TelegramAdapter` (same provider table, same request, same 60 s abort), plus `TranscriptionUnavailableError` (no provider) and `configuredVoiceProvider(config)` (the Telegram config's `voiceProvider`). Two small differences from the old private code: the audio's media type is a parameter (Telegram still passes `audio/ogg`; app notes pass the sniffed type, usually `audio/mp4`), and a response without a `text` string is an error instead of `undefined`.
- `TelegramAdapter.transcribeVoice` now delegates to the module; its call site and behaviour are unchanged.
- `AppConversationService`: new optional deps `transcribeVoice(filePath, mediaType)` and `transcribeDeadlineMs` (default 60 s). In `sessionLinesFor`, a `voice` attachment with no `transcript` gets `[voice:<path>] <transcript>` (control characters removed, one line, ≤ 4000 characters) or `[voice:<path>] (transcription unavailable: <reason>; the audio file is at that path)`. Transcriptions run in parallel with the other attachments' copies. Wired at both construction sites (`commands/server.ts`, `AgentServer.ts`).
- CLAUDE.md App conversation media section: the voice form now explains server transcription and the unavailable note; `migrateClaudeMd` refreshes the one sentence in place (content-sniffed, idempotent).
- `scripts/lint-no-direct-llm-http.js`: the grandfathered entry for the Whisper URL moves from `TelegramAdapter.ts` to `VoiceTranscription.ts` (same call, new file; no new direct-HTTP site).

Tier 1. Size: 5 source files, 1 lint script, ~200 LOC of source and ~250 LOC of tests. One build pass, no spec review rounds (the spec was already converged).

**Not built here (declared, tracked as ACT-179):** the spec stores the server transcript as a separate replicated `transcript` event and appends it when it arrives after the 60 s deadline; it also applies token removal and `scanInbound` to transcripts. This PR does neither: the transcript lives only in the session line, so the app's history still shows only phone transcripts, and a late transcript is dropped (the line says "took too long"). A voice note delivered later through "[file now available: …]" is not transcribed either. Adding a new replicated event kind needs an older-peer story (spec §4.1: an older peer refuses unknown kinds), which is why it is a separate step.

## Decision-point inventory

- Transcribe or not — add — invariant: `kind === 'voice'` and no phone transcript; nothing else decides.
- Dispatch without a transcript — add — invariant: fixed 60 s deadline (spec §4.5.1, `VOICE_TRANSCRIBE_DEADLINE_MS`).

No judgment, no block: every outcome still delivers the message.

---

## 1. Over-block

None. Nothing is refused; the worst case is a line saying transcription is unavailable, with the file path.

## 2. Under-block

- A transcript that dictates a pairing-invite or desktop code is not token-scrubbed (the spec asks for it on stored transcripts; this transcript is never stored). The Telegram voice path has the same property today.
- A late transcript is lost (see Summary).

## 3. Level-of-abstraction fit

The transcriber is one shared module below both callers (the spec names exactly this extraction). The app side calls it at the one place session lines are built. The Slack adapter keeps its own copy of the provider table in `commands/server.ts` (behaviour differs slightly: an explicit provider with a missing key falls through to auto-detect); switching it is a separate cleanup, not needed here.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No block/allow surface added. The deadline only decides whether the line has words in it.

## 4b. Judgment-point check

No competing-signals decision point. The provider choice keeps the existing rule (explicit, else Groq, else OpenAI).

---

## 5. Interactions

- **Dispatch latency:** the send route awaits `sessionLinesFor`, so the phone's send request now waits for transcription (typically 1–3 s with Groq, at most 60 s). The pull-before-dispatch wait (≤ 60 s) and the transcription wait are sequential only when a blob must first be pulled from another machine, which has no trigger yet (cross-machine increment's declared limit).
- **Telegram:** behaviour unchanged; the "not set" log line moves from `console.warn` to `console.log` with the same text.
- **Signed records:** the stored event and its signature are untouched; `verifyRecordedOrigin` compares only the phone's transcript, which is unchanged.
- **Spend:** each untranscribed app voice note costs one Whisper call on the operator's existing key, as each Telegram voice message already does.

## 6. External surfaces

- **Sessions:** the voice line for a note without a phone transcript changes from `[voice:<path>] (no transcript)` to a transcript or `(transcription unavailable: …; the audio file is at that path)`.
- **Transcription provider:** receives app voice audio when a key is configured (it already receives Telegram voice audio). With no key, nothing leaves the machine.
- **Phones:** none (same responses; a send may take a few seconds longer).

## 6b. Operator-surface quality

No operator surface added.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: transcription runs on the machine that dispatches to the session (the owner), using that machine's own provider key. Nothing new is stored or replicated. A machine without a key says so on the line.

## 8. Rollback cost

Revert the PR: app voice notes go back to `(no transcript)`; Telegram is unaffected either way. No state, config or data to repair. The CLAUDE.md sentence stays in its refreshed form on agents that updated (accurate text minus the transcription clause).

---

## Conclusion

Narrow reuse of the existing Telegram transcriber for app voice notes, never blocking delivery, with an honest note on every failure path. The stored-transcript event of the spec is the declared remaining part of increment 2.

## Evidence pointers

- `tests/unit/app-voice-transcription.test.ts` (12 tests: provider choice, request shape, each dispatch outcome on real blobs)
- `tests/integration/app-voice-transcription.test.ts` (HTTP pipeline, transcribed and provider-failure)
- `tests/e2e/mobile-native-media-alive.test.ts` (no provider: unavailable note, readable file)
- `tests/unit/PostUpdateMigrator-appMedia.test.ts` (CLAUDE.md voice sentence refreshed once)
