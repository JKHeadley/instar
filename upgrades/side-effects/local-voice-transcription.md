# Side-Effects Review — On-machine voice transcription (whisper.cpp)

**Version / slug:** `local-voice-transcription`
**Date:** `2026-11-14`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Spec: `docs/specs/backup-on-machine-voice.md` (converged in 6 rounds, GPT-tier + internal reviewers). Tier 2: untrusted audio goes into native programs, and four inbound channels change.

- New `src/core/LocalVoiceTranscriber.ts`: finds `whisper-cli`/`whisper-cpp`, `ffmpeg` and a ggml model (env overrides, PATH, fixed Mac/Linux dirs, the new `~/.local/share/instar/models` and the legacy `media` folder); readiness states (missing / installed-unproven / proven / failed) where only installation-level failures change readiness; hardened ffmpeg conversion (file protocol only, single-file audio demuxers only, 2 h cap, 60 s bound); silence measured from the audio (whisper hallucinates " you" on real silence — captured); whisper run with argument arrays, SIGKILL at a per-run cap; one run per machine via a per-user lock directory (serialized takeover, token-checked release), earliest-deadline-first in-process, fail-fast `busy` from a measured-speed estimate.
- `src/core/VoiceTranscription.ts`: order explicit `local` → configured paid → local; fallback to local after any paid failure, with a 20 s reserve so a hanging paid service still leaves time; key refusals (401/402/403) raise one degradation report (re-armed after a success); `TranscriptionUnavailableError` gains `missing` + `userMessage`; new `TranscriptionFailedError` (plain `reason`, `fault`); `transcribeAudioFileDetailed`, `canTranscribe`, `cannotTranscribeReason`, `describeVoiceTranscription` (cached-only path never reads the keychain); `voiceTranscription.local` off switch.
- Channels: Telegram failure now reaches the SESSION as `[voice] (transcription unavailable: <reason>)` (no path; the download is still deleted) instead of a canned reply, and the text-match on the error message is gone; Slack and WhatsApp drop their private provider copies and use the shared function; Slack/WhatsApp failure lines carry the reason; WhatsApp transcripts are now escaped; the app stores the real provider label per transcript and the plain reason on failure, and only real faults are reported.
- `GET /voice-transcription` route, `voiceTranscription` capability block, an awareness entry file (`src/data/awareness/voice-transcription.md`, the registry from #3171), the app-media voice line refreshed via migration, catalog row `voice-transcription` → backup `exercised` (drill: the new e2e).

Size: about 18 source/test files, ~1,100 added lines (≈450 module, ≈250 integration, ≈400 tests). Effort: 6 spec rounds (the cap; high for the size, mostly the lock and timing details), commit attempts recorded at commit.

## Decision-point inventory

- Which transcriber runs — **modify**: deterministic order over enumerable inputs (explicit setting, paid key present, local readiness).
- Fallback after a paid failure — **add**: one extra on-machine attempt; no loop.
- Local `failed` window after an installation-level failure — **add**: a readiness signal for this transcriber only; never blocks a message (the note is still delivered with its reason).
- Fail-fast `busy` when a note can't fit behind the running job — **add**: per-note outcome, delivered with its reason.
- Telegram failure delivery — **modify**: previously a canned reply to the person; now the message goes to the session. Not a block: it delivers MORE to the agent than before.

---

## 1. Over-block

- A real but very quiet recording (peak below −50 dBFS) is reported "seems silent" and not transcribed. Reported as a measurement, with the path to act (resend / the kept file on Slack and the app). Normal speech peaks far above −30 dBFS.
- A note that arrives while another long local run is going can fail as `busy` ("try again in a minute") on the 60 s channels. The estimate uses measured speed, so short runs don't trigger it (unit test: short notes queue; only a note that can't fit fails).
- Audio containers outside the whitelist (ogg, mov/mp4/m4a/3gp, mp3, wav, webm/matroska, flac, aac) are refused by ffmpeg. That covers Telegram (Opus/OGG), the app (m4a/mp4), Slack and WhatsApp (OGG). A rare format (e.g. AMR) would fail as "audio could not be read" — still delivered with the reason.
- An agent whose operator explicitly set `voiceProvider: "groq"` without a key now gets local instead of nothing. Intended (audio stays on the machine); the off switch restores the old behaviour.

## 2. Under-block

- A truncated model that still has the magic bytes and size passes detection; it fails at the first real run and becomes `failed` ("the model file may be damaged"). One note pays for that.
- whisper may still hallucinate on noisy (non-silent) audio; the text is returned as an untrusted `[voice]` transcript like every transcript.
- Several agents running as different OS users on one machine each have their own lock, so they can run whisper at the same time (accepted; uncommon).
- A paid service that keeps hanging costs each Telegram note up to 40 s before the backup runs; only logged, no auto-pause (left behind in the spec).

## 3. Level-of-abstraction fit

Right layer: the single shared module every channel already called (or should have called) is where provider choice lives. Moving Slack and WhatsApp onto it removes two drifted copies. The machine-specific mechanics (detection, lock, ffmpeg/whisper) live in their own module so VoiceTranscription stays the policy layer. No smarter gate exists to feed; this is a provider, not a gate.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. No blocking authority over messages or actions is added. Every outcome — success, unavailable, failed, busy, silent — still delivers the voice note (or its reason) to the agent; the change only decides HOW the text is produced. The `failed` readiness state and the `busy` rule are signals about this transcriber's own availability, and their effect is a plain reason line, never a dropped message. The key-refused degradation report is signal-only.

## 4b. Judgment-point check (Judgment Within Floors standard)

The provider order is not a competing-signals point (explicit setting wins; otherwise presence of a configured key or a ready install). The numeric limits (per-run cap, 20 s reserve, 5 s fallback floor, queue depth 8, 10-minute failed window, −50 dBFS, 60 s conversion bound) are judgment-candidate defaults with floors (never past the caller's budget, SIGKILL, plain per-note failure) declared in the spec's Decision points table. None blocks a message.

## 5. Interactions

- **App limiter (3 concurrent, 10-minute ceiling)**: unchanged; the local queue nests inside it. The ceiling's remaining time is passed as the budget, so a local run never outlives the app's own timeout.
- **Telegram serial update loop**: the 60 s budget equals today's paid limit, so worst-case stall is unchanged; fail-fast `busy` avoids waiting the full 60 s behind a long app run.
- **Inbound escaping** (`escapeTypedPathTags`): the failure line has no typed path tag; reasons are fixed phrases and are escaped anyway.
- **Degradation reporter**: only real faults (paid errors, broken install) are reported; per-note outcomes are not, so they can't drown out real faults.
- **Stored vault key** (`registerStoredTranscriptionKey`): still read on the transcription path as before; never on `/capabilities`.
- **Recommended-services voice recipe**: unchanged; its verify still checks the paid key. The catalog row's backup line changes to `exercised`.
- **Existing tests** that called the real transcriber with an empty environment are pinned with `localEnabled: false` / `voiceTranscription.local: false` so they behave the same on machines with and without whisper.cpp.

## 6. External surfaces

- New authenticated route `GET /voice-transcription`; new `/capabilities.voiceTranscription` block.
- Telegram: when no session handler is wired at all, the person still gets a direct plain reply ("I couldn't read that voice note: <reason>"). Otherwise the person no longer gets the canned "I can't read voice notes yet…" reply; the agent answers instead, in its own words. When no session takes the message (e.g. an owner-gated conversation), the person hears nothing, as for any refused message.
- Slack/WhatsApp lines now carry `(transcription unavailable: <reason>)`.
- Spawns `ffmpeg` and `whisper-cli` child processes (CPU) on machines where they are installed; temp WAVs in a private temp folder, removed each run; a lock directory under `~/.local/state/instar`.
- No network use by the local path. No new third-party service; the install steps use Homebrew / a GitHub source build / a Hugging Face model download, only when the agent installs on the person's yes.

## 6b. Operator-surface quality

Not applicable: no dashboard, approval page, or grant/revoke/secret form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Detection, readiness, the lock and runs: **machine-local by design** (hardware-bound-resource): the program, model and CPU are on that machine, and the machine doing the work holds the audio file.
- The machine that transcribes is the one doing the work (Telegram's poller, the app's dispatcher), so the awareness text tells the agent to install on every machine; the route names its machine.
- No user-facing notices are emitted by the feature itself (failure reasons ride the existing inbound message to the session, which is already one-voice gated by the session pool). No durable state is introduced. No URLs.
- **Status surfaces:** `GET /voice-transcription` and `/capabilities.voiceTranscription` both answer for **this machine only** (the `machine` field and the summary name it). A pool-wide view is a tracked follow-up commitment.

## 8. Rollback cost

- `voiceTranscription.local: false` in config turns the on-machine provider path off (paid-only transcription) without a release. It does not bring back Telegram's old canned reply or the separate Slack/WhatsApp copies; those channel changes need a code revert.
- Full revert: pure code change; ship a patch. No persistent state (temp WAVs and a lock dir only). The awareness entry disappears from every agent's instructions on the next update after a revert (the registry rebuilds the section); the refreshed app-media line stays, and is accurate except for naming whisper.cpp.

## Conclusion

The review shaped the design heavily (see the convergence report): hardened ffmpeg input, readiness tied to real runs, budgets that keep Telegram's existing limit, a per-machine lock that can't be stolen, typed plain reasons on every channel, and Telegram failures routed to the agent rather than a canned reply. No blocking authority is added. Clear to ship after the second-pass read and the live proofs (Telegram + Slack on a throwaway agent; the app on Echo after deploy).

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (Claude Opus 5.5), read the artifact and the diff
**Independent read of the artifact: concur**

Concur: no new blocking authority; every local outcome is delivered as a reason line; lifecycle and dispatch untouched. Four points, all resolved before commit: (1) §8 overstated the off switch — reworded; (2) a throw after a successful Telegram transcription could replace the person's words with "unavailable", and an unguarded log write on the failure path could lose the message — the try now covers only the transcription, and the failure-path log write is guarded; (3) a failed owner-file write right after `mkdir` could leave a lock behind — the folder is now removed before rethrowing; (4) the lock's staleness clock (directory mtime) wasn't refreshed by a live run — `setExpectedEnd` now touches it. (5) §6 now mentions the no-handler direct reply.

---

## Evidence pointers

- `tests/unit/voice-transcription-local.test.ts` — 35 tests, including real ffmpeg + whisper.cpp 1.9.5 on the real Opus fixtures on the Studio (speech transcribed, silence measured, HLS/concat playlist refused).
- `tests/fixtures/voice/` — real captured audio and whisper output.
- `tests/unit/voice-transcription-awareness.test.ts`, `tests/unit/app-platform-media.test.ts` (Telegram failure path).
- `tests/integration/voice-transcription-route.test.ts`, `tests/e2e/local-voice-transcription-lifecycle.test.ts` — run by Local Verify (the brief forbids running those configs by hand on the Studio).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed by this change. For the self-action class:

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `n/a` (negative declaration)
- **reason:** one-shot per inbound voice note: ffmpeg + whisper-cli run once per received note (plus at most one local fallback after a failed paid call), never re-triggered by their own outcome; bounded by the caller's budget, one run per machine, queue depth 8.
