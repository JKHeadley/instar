---
title: "Reading voice notes on the agent's own machine"
slug: "backup-on-machine-voice"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "backup-on-machine-voice.eli16.md"
related-specs: "recommended-services.md"
status: "draft"
approved: true
approved-by: Justin
approved-via: "Telegram topic 142909, 2026-11-14 14:35 PST: 'lets use this as a learning experience to improve the robustness of the full process including an Instar agent's awareness. The user experience should be seamless', relayed by the Chief of Staff as a build directive (brief .instar/state/autonomous-briefs/143126-local-voice.md). Standing rule 2026-11-05: never require a purchased third-party service."
review-convergence: "2026-11-15T00:14:34.037Z"
review-iterations: 6
review-completed-at: "2026-11-15T00:14:34.037Z"
review-report: "docs/specs/reports/backup-on-machine-voice-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Reading voice notes on the agent's own machine

Owner: Echo. Third in the backup work order (`recommended-services.md`, Frontloaded Decisions). Closes the `gap` on the `voice-transcription` row.

## Problem statement

`VoiceTranscription` calls Groq or OpenAI. With neither key, a voice note can't be read, and the agent can only say so.

Real incident, 2026-11-14 14:21 PST: Justin's voice note from the Android app reached Echo as "transcription unavailable". Echo has no Groq or OpenAI key, yet the Studio already had `whisper-cli` (whisper.cpp, Homebrew) and a `ggml-base.bin` model, and a session transcribed the same file by hand in about two seconds (ffmpeg to 16 kHz mono WAV, then `whisper-cli -nt`). The machine could read the note; the server didn't know how.

Three more gaps the incident exposed:

1. Slack and WhatsApp each carry their own copy of the provider table and HTTP call, so a fix in `VoiceTranscription` would not reach them.
2. The agent can't tell anyone which transcriber it has: nothing in `/capabilities` or any route says so.
3. The failure text ("no transcription service is set up") names a paid service as the only way forward.

## Acceptance

With no provider key and no network, a voice note on Telegram, the app, Slack or WhatsApp is read on the machine through the same shared function. The agent can say which transcriber is active. With nothing installed, the person gets one plain sentence naming what is missing and an offer to set it up. A live proof with a real voice note passes, and the catalog row moves off `gap`.

## Design

### Engine and model

whisper.cpp's `whisper-cli` with a ggml model file. Free, open source, CPU on Mac (Metal in the Homebrew build) and Linux, no network after install. Homebrew ships it as `whisper-cpp`.

**Finding the program** (first hit wins):
1. `INSTAR_WHISPER_CLI`, if it names an executable file.
2. `whisper-cli`, then `whisper-cpp` (older Homebrew binary name), on `PATH`.
3. The same two names in `/opt/homebrew/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`, `/usr/bin`, `~/.local/bin`. The server's `PATH` under launchd or systemd is often short, which is why the fixed list exists.

`ffmpeg` is found the same way (`INSTAR_FFMPEG`, `PATH`, the fixed list).

Trust boundary: relative `PATH` entries are skipped, and the fixed locations are writable only by the agent's own user account or root on a normal install (a `PATH` the operator configured is trusted as the operator's choice). Someone who can plant a binary there already controls the account, so these lookups add no new attack surface. Detection never runs the program (no `--help` probe): it only `stat`s files, so a status read never starts a process.

**Finding the model** (first hit wins):
1. `INSTAR_WHISPER_MODEL`, if it names a readable file.
2. The model folder this change introduces, `$XDG_DATA_HOME/instar/models` (default `~/.local/share/instar/models`), then the legacy `~/.local/share/instar/media` (where the Studio's hand install lives). In each, the first of `ggml-base.bin`, `ggml-base.en.bin`, `ggml-small.bin`, `ggml-small.en.bin`, `ggml-tiny.bin`, `ggml-tiny.en.bin`, then any other `ggml-*.bin` in name order. No inbound media is ever written to either folder, so a file someone sends can't be picked up as a model.
3. A candidate counts only if it is over 1 MB and starts with the ggml magic bytes `lmgg` (checked by reading 4 bytes). That is a structural check only: a truncated file can pass it. A model is proven only by a successful run; a model that fails to load marks local `failed` with "the model file may be damaged". The install steps download to `ggml-base.bin.part`, verify the checksum, then rename, so a download in progress never matches `ggml-*.bin`.

Base is the default because it is fast on CPU and good enough for voice notes. When several models are present the first in the list above wins; a person who wants a larger model alongside base sets `INSTAR_WHISPER_MODEL` (or removes base), and the agent's install steps say so.

### Readiness is a state, not a file check

`resolveLocalTranscriber()` returns one of:

- `missing` — with `missing: string[]` in plain words (e.g. "the whisper.cpp program", "a whisper model file", "ffmpeg").
- `installed-unproven` — program, model and ffmpeg all found; no run has happened yet in this server process.
- `proven` — the last local run succeeded on exactly this install (time and the install's paths and file times recorded; replacing the program or model makes it `installed-unproven` again).
- `failed` — the last local run failed, with its plain reason and time.

A file being present is only a symbol; the corroboration is a real run. Only an installation-level failure changes the state to `failed`: the program can't be started (missing, not executable, wrong CPU type), or whisper exits non-zero or crashes on a WAV that ffmpeg produced successfully (model won't load, out of memory). Failures that belong to one request never change readiness: ffmpeg rejecting the input (a malformed or non-audio attachment), a queue or budget timeout, a caller cancelling, or a silent recording. `failed` makes `canTranscribe()` false for local for 10 minutes (or until any of the three files changes its mtime), so a broken install doesn't make every note wait for a certain failure; after that window one real run tries again. Detection results are cached 60 s; the readiness state is in memory and resets on restart to `installed-unproven`. Unmeasurable (a check that fails for any reason: not found, permission, I/O) reads as that piece `missing`, never as ready.

### Conversion, hardened for untrusted audio

A voice note is untrusted input from outside the machine. ffmpeg runs as:

```
ffmpeg -nostdin -hide_banner -loglevel error -protocol_whitelist file
  -format_whitelist ogg,mov,mp4,m4a,3gp,mp3,wav,webm,matroska,flac,aac
  -i file:<input> -vn -map 0:a:0 -t 7200 -ar 16000 -ac 1 -c:a pcm_s16le -y <tmp>/audio.wav
```

- `-protocol_whitelist file` stops any network fetch. It does not by itself confine ffmpeg to the one input file, so the boundary is the demuxer list: `-format_whitelist` admits only single-file audio containers, which excludes every demuxer that follows references to other files (`hls`, `concat`, `dash`, image sequences, and the like); and the mov/mp4 demuxer's external data references stay off (`enable_drefs` defaults to 0 and is never set). A unit test feeds an HLS playlist and a concat list named `voice.ogg` and asserts ffmpeg refuses them. No stronger filesystem isolation (a sandbox) is attempted: the input is a voice note the agent already stores, ffmpeg runs as the agent's own user, and the demuxer list is the industry-standard control for this.
- `-t 7200` caps the audio at 2 hours (a WAV of about 230 MB, far past any voice note; Telegram's 20 MB bot download limit is about 2 hours of voice-note Opus at its usual bitrate). If the converted audio reaches the cap, the transcript ends with "(only the first 2 hours were transcribed)", so the cut is never silent; where the channel keeps the file the rest is still there.
- Output goes to a private `mkdtemp` folder, removed in `finally`, including after a kill.
- Opus-in-OGG (every Telegram voice note) is required to go through ffmpeg: whisper-cli's built-in reader fails on it (checked on the Studio, whisper.cpp 1.9.5: `read_audio_data: failed to read audio data`).

### Run

`whisper-cli -m <model> -f <wav> -nt -np -t <threads>`, threads `min(4, max(1, cpus - 1))` (4 is whisper.cpp's own default). `execFile` with an argument array, never a shell; `maxBuffer` 1 MB, overflow is a plain failure. Output is stdout, trimmed.

**Silent recordings**: whisper invents words on silence (the real capture in `tests/fixtures/voice/` shows 3 s of digital silence transcribed as " you"). So silence is judged from the audio, not the text: the server reads the 16-bit samples of the converted WAV (asynchronously, in 1 MB chunks, so even a 2-hour file never blocks the event loop) and, if the peak is below -50 dBFS, returns a failure with the reason "the voice note seems to be silent (no sound above background level)" without running whisper. That is reported as a measurement, not a verdict: where the channel keeps the file (Slack's document line, the app's stored attachment) the agent can still look at it; on Telegram and WhatsApp, which delete their download, the path to act is asking the person to resend or type it. A transcript that is exactly `[BLANK_AUDIO]` reads the same way. Any other text, including a possible hallucination, is returned as the transcript: it stays labelled `[voice]`, is treated as untrusted person text like every transcript, and gets no new trust.

### Time limits

One budget per call covers everything (paid attempt, queue wait, ffmpeg, whisper):

- The budget is the caller's `timeoutMs` (default 60 s). Telegram, Slack and WhatsApp use 60 s, the same limit their paid call has today, because Telegram handles updates one at a time and a longer wait would hold up every topic. The app passes its existing 10-minute ceiling (its dispatch already delivers a slow transcript as a later line).
- The paid attempt keeps its own 60 s limit, but never more than the budget (its timer starts before the file is read, and nothing is sent when the budget is already spent), and when local is ready it is held to the budget minus a 20 s reserve, so a paid service that hangs still leaves time for the fallback (a Telegram note: paid up to 40 s, then local). Paid calls normally answer in a few seconds, so the reserve rarely shortens a successful paid call.
- On a paid failure the local fallback gets whatever budget is left; it is skipped only when less than 5 s remain.
- Conversion has its own bound (60 s; converting even 2 hours of Opus takes seconds), and the WAV measurement checks the deadline as it reads.
- Each local run also has its own cap: 60 s plus twice the audio's length (known exactly from the WAV size), never more than the remaining budget. That way one long note cannot hold the queue for the whole 10-minute app ceiling.
- When a limit is reached, ffmpeg and whisper get SIGKILL and the result is "on-machine transcription took too long".

### One local run at a time, per machine

One local transcription runs at a time on the whole machine, across every agent on it: whisper uses several threads, and parallel runs on a small machine slow the agents' own servers. In-process, a queue (depth cap 8; beyond that a note fails at once with "too many voice notes are waiting; try again in a minute"). Across processes, a lock directory `instar-whisper-run.lock` in a per-user folder (`$XDG_STATE_HOME/instar`, default `~/.local/state/instar`; not the shared `/tmp`, where another account could plant a lock this user can't remove) created atomically (`mkdir`), holding `owner.json` with the owner's pid, a random token, start time and `expectedEnd`. A lock whose pid is gone, or whose directory is older than the longest possible run (the app's 10-minute budget, so 15 minutes, judged by the directory's own mtime rather than a time the owner wrote), is stale. A lock that can't be taken over ends as a plain `busy` or `took too long` failure for that note, never a silent hang. Agents running as different users on one machine each have their own lock. Takeover is serialized: a waiter that judges the lock stale must first create a second lock directory, `instar-whisper-run.lock.takeover` (atomic `mkdir`; a takeover lock older than 30 s is itself stale, because a takeover takes milliseconds). Holding it, the waiter re-reads `owner.json`; only if it is still the same stale owner (same token, still dead or still over-age) does it rename the run lock aside and remove it, then it drops the takeover lock and retries `mkdir`. A new run lock can only be created after the stale one is gone, and only takeover holders remove a stale one, so a waiter acting on an old observation can never remove a live lock. Node has no built-in OS file lock (`flock`), which is why the directory protocol is used. Release checks that `owner.json` still carries this process's token before removing the lock, so a process whose lock was taken over never deletes the new owner's lock. Waiting polls every 250 ms and counts against the caller's budget. Tests cover simultaneous takeover, a dead owner, and a release after takeover.

**Short budgets are not starved by long runs.** Within one server process, waiting notes are served earliest-deadline first (a Telegram note with 60 s goes ahead of an app note with 10 minutes). Across processes (other agents on the machine) ordering is best effort: whichever process polls first after the lock frees wins; the fail-fast rule below still bounds how long any note waits. The running job records an estimate of when it will finish (in memory, and as `expectedEnd` in the lock's `owner.json` for other processes): audio length × the machine's measured real-time factor (a moving average of real runs, starting at 0.5) × 1.5, plus 2 s. The per-run cap is only the SIGKILL line, never the estimate. A note whose deadline can't fit behind that estimate (the current run's `expectedEnd` plus 20 s for its own run is past its deadline) fails at once as `busy` with "another voice note is being transcribed on this machine; try again in a minute" instead of holding Telegram's update loop for its full 60 s.

On the Studio, work launched from tmux runs on the efficiency cores (memory note 2026-11-10), so a run there can be several times slower than on a free machine. The measured real run (1.2 s for a 5 s note, base model) leaves wide room under the 60 s budget for typical voice notes.

### Order of preference

1. `voiceProvider: "local"` (Telegram config; Slack `audioTranscriptionProvider: "local"`): local only. Audio never leaves the machine.
2. A paid provider that is configured (explicit name with its key, a key in the environment, or the key the setup recipe stored): used first, as today.
3. Local, when no paid provider is configured. An explicit paid provider whose key is missing counts as not configured: audio staying on the machine is not "replacing a vendor", which is what the old rule guarded against.
4. **Fallback**: when the paid call fails for any reason and local is ready, local runs once with the remaining budget; if that also fails, the reason names both. A working paid call re-arms the key-refused report. When the paid failure is the key being refused (401, 402, 403), the server also raises one degradation report per process ("voice transcription key refused by <provider>; voice notes are being read on this machine meanwhile"), so the agent can tell the person and offer to fix the key, instead of the fallback hiding it forever.
5. `voiceTranscription.local: false` in `.instar/config.json` turns local off entirely (the old behaviour, for rollback or a person who wants it off). Absent means on. It is read on every call (from the loaded config), so it applies at the next config reload without code changes.

Slack's `audioTranscriptionProvider` type (`slack/types.ts`) gains `'local'`. Every failure reason is a fixed server phrase (never ffmpeg's stderr or a provider's response body), and is passed through `escapeTypedPathTags` on every channel anyway. The app allows 3 transcriptions at once while local runs one per machine; the app's 10-minute budget absorbs the wait. For the app, where a failed note is not retried, the path to act is "resend the note".

Which provider the app reads: the app and WhatsApp follow the Telegram config's `voiceProvider` (today's behaviour), else auto. An agent without Telegram gets auto, which now includes local.

### One function for every channel

`transcribeAudioFile(filePath, opts)` stays the single entry point; `transcribeAudioFileDetailed(filePath, opts)` returns `{ text, provider }` (provider `groq` / `openai` / `local`). New exports: `resolveLocalTranscriber()`, `describeVoiceTranscription()` and `canTranscribe()` (all synchronous; local readiness is file checks only, and the paid side is the same configuration check WhatsApp already made before downloading, which can read the stored vault key; the `/capabilities` path never reads it), and `TranscriptionFailedError` (a failure with a plain `reason`).

`TranscriptionUnavailableError` gains `missing: string[]` and `userMessage`, the plain sentence: "I can't transcribe voice notes on this machine yet: <missing, joined>. Ask me to set it up and I'll do it." Every consumer checks it with `instanceof` (Telegram's text match at `TelegramAdapter.ts` is replaced); a unit test fails if any source file matches the error's message text.

- **Slack** (`server.ts`) and **WhatsApp** (`BaileysBackend`) drop their private provider tables and HTTP calls and use the shared function. WhatsApp's "no provider → `[Audio]`" becomes "can't transcribe → `[Audio]`", and its transcript now goes through `escapeTypedPathTags` like Telegram's and Slack's.
- **App** (wired in both `AgentServer.ts` and `commands/server.ts`): the `transcribeVoice` dependency returns `{ text, provider }`, and `storeTranscript` labels the stored transcript with the provider that actually produced it. No shared "last provider" state, so concurrent transcripts can't swap labels. The old `voiceProviderName` dependency stays only as a fallback label for a dependency that returns a bare string.

### What the person and the agent see

Every failure carries a plain reason (`TranscriptionFailedError.reason`, or the unavailable error's `userMessage`), and every channel passes it on with a path to act:

- **Telegram**: on any failure the session gets a message `[voice] (transcription unavailable: <reason>)` instead of the person getting a canned reply. The agent then answers in its own words and can act: offer to install the transcriber, or ask the person to resend after it is set up or to send a shorter note. The line is logged with `provenance: 'user'` like every inbound line; a person could type the same words, which only makes the agent answer about a voice note, no new authority. When no session takes the message (for example a conversation gated to its owner), the person hears nothing, the same as for any other refused message. The text carries no path (inbound text escapes typed path tags, and history lines never carry paths), and the downloaded file is still deleted afterwards as today, so no voice recording is left in the state folder for git sync to pick up. When app conversations are on, the person's audio is also in the app's media store, where `copyInboundMedia` puts it before transcription. History records the same `[voice] (transcription unavailable: <reason>)` line. For the not-installed case the reason is the missing list, e.g. "the free on-machine transcriber (whisper.cpp) needs the whisper.cpp program, a whisper model file and ffmpeg, and no transcription service is set up".
- **App**: the stored reason is the plain reason (took too long, too many waiting, seems silent, the missing list) instead of a generic "the transcription service failed". Only real faults (an installation-level local failure, a paid provider error) go to the degradation reporter; silent, busy and not-installed outcomes do not, so they can't drown out real faults.
- **Slack**: a failed transcription becomes `[document:<path>] (transcription unavailable: <reason>)` instead of a bare document tag.
- **WhatsApp**: a voice note it can't transcribe becomes `[Audio] (transcription unavailable: <reason>)` instead of a bare `[Audio]`.
- A silent recording is a failure with its reason, never text in the transcript slot.
- Never a bare "unavailable": every path names the cause.

On the 60 s channels (Telegram, Slack, WhatsApp) the longest note local can read is about 3 to 4 minutes on the Studio at the measured speed (more on a free machine); a longer one fails with "took too long"; the agent asks for a shorter note (or, on Slack and the app, can look at the kept file). The app's 10-minute budget covers notes of about 30 minutes there.

### How it gets installed with no steps for the person

The server never installs software by itself. The agent installs it on the person's yes; the awareness text gives the exact steps:

- **Mac**: `brew install whisper-cpp ffmpeg`.
- **Linux**: Homebrew on Linux if present (`brew install whisper-cpp ffmpeg`); otherwise the distro's `ffmpeg` package plus a whisper.cpp source build at a pinned release tag (`git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp`, `cmake -B build && cmake --build build -j 2 --config Release`, copy `build/bin/whisper-cli` to `~/.local/bin`).
- **Model**: download `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin` into `~/.local/share/instar/models/` and check its SHA-256 is `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` (the Studio's working copy) before use.
- **Every machine** the agent runs on (through its usual way of running commands on its other machines, then `GET /voice-transcription` on each), because the machine that does the transcription can be a different one from the one the person thinks of (see Multi-machine posture).
- Confirm with `GET /voice-transcription`.

The person's only step is "yes". Installing is free; no account.

### Awareness and status

- **Route**: `GET /voice-transcription` (Bearer) returns `describeVoiceTranscription()` fresh: `active`, `paid`, `local` (state, missing, binary/model/ffmpeg paths, last run), `machine` (this machine's name), and a one-line plain `summary` naming the machine.
- **Capabilities**: `CapabilityIndex` key `voiceTranscription`, prefix `/voice-transcription`, endpoints listed. Its `build()` is synchronous and on the `/capabilities` path, so it reads only the cached description; when the cache is empty it describes local (file checks only) and paid from the environment only, and marks `storedKeyChecked: false`. It never reads the keychain or starts a process.
- **Agent awareness**: one entry file, `src/data/awareness/voice-transcription.md` ("Voice messages and transcription"), under the awareness entry registry (docs/specs/awareness-entry-registry.md): written into every agent's instructions, new and existing, on each update, so no migration step is needed. A unit test checks the entry renders with the route, install steps and off switch.
- **Catalog**: the `voice-transcription` row's backup becomes "Your agent reads voice notes on its own machine with whisper.cpp, free, once it's installed (I can install it)", status `exercised`, drill `tests/e2e/local-voice-transcription-lifecycle.test.ts`.

## Decision points touched

| Decision | Classification | Floor / justification |
|---|---|---|
| Which transcriber runs (explicit local → configured paid → local) | invariant; basis: enumerable-domain; evidence: the inputs are three enumerable facts (explicit setting, a resolvable paid key, local readiness state) and the person's explicit setting must win | Deterministic order. |
| Fall back to local after a paid failure | invariant; basis: enumerable-domain; evidence: the trigger is a thrown paid error (binary) and the action is one extra on-machine attempt with no outside effect, so no loop is possible | One attempt; key refusals also raise a report. |
| Per-call budget (caller's limit: 60 s for Telegram/Slack/WhatsApp, 10 min for the app) | invariant; basis: external-constraint; evidence: Telegram handles updates serially (`TelegramAdapter.ts` processUpdate loop), so any wait longer than today's 60 s paid limit holds up every topic; the app's 10-minute ceiling is existing behaviour, unchanged | Unchanged limits per channel. |
| Per-run local cap (60 s + 2 × audio length, within the budget) | judgment-candidate; floor: never past the caller's budget, SIGKILL at the cap, plain failure; arbiter: the measured audio length | Base model measured at about 0.25 × real time on the Studio; 2× covers a machine about 8 times slower. |
| 20 s reserved for local when local is ready | judgment-candidate; floor: the paid call still gets the rest of the budget; arbiter: local readiness | The measured local run for a 5 s note was 1.2 s; 20 s covers ffmpeg, model load and a note of a minute or two on a slower machine. |
| Conversion bounded at 60 s | judgment-candidate; floor: never past the budget, SIGKILL, per-note failure; arbiter: the budget | ffmpeg converts Opus to WAV hundreds of times faster than real time. |
| Fallback skipped under 5 s remaining | judgment-candidate; floor: fallback never extends the budget; arbiter: the remaining budget | The measured run for a 5 s note was 1.2 s; under 5 s even ffmpeg plus a model load can't reliably finish. |
| One local run at a time per machine, in-process queue depth 8 | judgment-candidate; floor: wait counts against the budget, overflow fails plainly, stale locks (dead pid or over 15 min) are taken over; arbiter: the caller's budget | Protects every agent server's CPU; 8 is about two minutes of typical notes. |
| Local marked failed for 10 minutes after a failed run | judgment-candidate; floor: any file change re-checks at once; arbiter: the next real run after the window | Avoids every note waiting on a certain failure; short enough that an install fix is picked up soon. |
| "Seems silent" when peak below -50 dBFS, or output exactly `[BLANK_AUDIO]` | judgment-candidate; floor: reported as a measurement with the audio file still pointed at, never as a certified "no speech"; anything else is returned as-is, untrusted; arbiter: the measured audio level | Digital silence is -inf dBFS; ordinary speech peaks well above -30 dBFS. |
| 2-hour audio cap | invariant; basis: external-constraint; evidence: Telegram's bot download limit (20 MB) holds under 2 hours of voice-note Opus, so a Telegram note is never cut; the cap bounds a temp WAV at about 230 MB on a disk-constrained host | The transcript says when it was cut and the audio file stays available. |

| 60 s detection cache | invariant; basis: external-constraint; evidence: installing takes minutes, so a 60 s stale answer delays the first success after an install by at most a minute, and `GET /voice-transcription` reads fresh | Cache. |
| 4 whisper threads (or cpus - 1) | judgment-candidate; floor: at least 1, never more than the machine has; arbiter: whisper.cpp's own default of 4 | Cheap to change. |
| 1 MB whisper output buffer | invariant; basis: external-constraint; evidence: 2 hours of speech is well under 100 KB of text, so 1 MB only trips on runaway output | Overflow is a plain per-note failure. |
| 15 min stale run lock, 30 s stale takeover lock | judgment-candidate; floor: a dead owner pid is stale at once; arbiter: the lock directory's own mtime | 15 min is past the longest run (the app's 10-minute budget); a takeover takes milliseconds. |

> fixed-limits: per-call budgets (invariant, unchanged existing limits); per-run cap, 20 s local reserve, 5 s fallback floor, one-per-machine and depth 8, 15-minute stale lock, 10-minute failed window, -50 dBFS (judgment-candidates, above); 2-hour audio cap (invariant, above); 60 s detection cache (invariant; basis: external-constraint; evidence: installing takes minutes, so a 60 s stale answer delays the first success after an install by at most a minute, and `GET /voice-transcription` reads fresh); 4 threads (whisper.cpp's own default; judgment, cheap to change); 1 MB output buffer (invariant; basis: external-constraint; evidence: 30 minutes of speech is well under 100 KB of text).

## Multi-machine posture

- Local transcriber detection, readiness state and runs: `machine-local`. machine-local-justification: hardware-bound-resource — the program, model file and CPU are physically on that machine; there is no credential involved.
- The machine that transcribes is the one that does the work, not necessarily the one the person thinks of: Telegram notes are transcribed on the machine currently polling (it changes on failover), and app notes on the machine running the dispatch after the file is copied to it. So the awareness text tells the agent to install on every machine it runs on, and `GET /voice-transcription` names the machine it describes. A pool-wide view (`scope=pool`) is not in this change: the agent asked "can you read voice notes?" answers for its own machine and installs on the others; Echo action ACT-613 (due 2026-11-29) holds that work (Left behind).
- A failed app transcription is not retried (existing behaviour), so a note that failed before an install stays unread; the agent can still read the audio file at the path given.
- No durable state is introduced; nothing to replicate.

## Frontloaded Decisions

1. Paid provider stays first when configured; local is the default only without one, and the fallback after a paid failure (brief, 2026-11-14).
2. The server never installs software; the agent installs on the person's yes, with the exact steps above.
3. Model preference base → small → tiny, then any other model; a larger model alongside base needs `INSTAR_WHISPER_MODEL`. Model folder `~/.local/share/instar/models`, legacy `media` also read.
4. Slack and WhatsApp move onto the shared function in this change.
5. Catalog row moves to `exercised` with the e2e as its drill.
6. Telegram, Slack and WhatsApp keep their 60 s budget (no move off the polling loop in this change).
7. `voiceTranscription.local: false` is the off switch; absent means on.
8. Live proof covers Telegram and Slack through real channels on a throwaway agent, and the app through the real Android app: after the change is deployed to Echo, the echo-android-app session sends a real voice note from the app and confirms the transcript arrived (it owns the app test route). WhatsApp has no test route; it is covered by the shared-function unit and e2e tests (it calls the same function).

## Open questions

*(none)*

## Testing

- **Unit** (`tests/unit/voice-transcription-local.test.ts`): detection order (env var, PATH, fixed dirs, model preference, magic-byte and size check, missing pieces named); readiness states including `failed` and its window; order of preference (explicit local, paid first, local when none, explicit paid without key → local, `local: false`); fallback on paid failure and the key-refused report; budget arithmetic (5 s skip, per-run cap); kill on timeout; queue order and depth; ffmpeg argument list (protocol and format whitelists, `file:` prefix, `-t`); no-speech by audio level using the real `silence.ogg` → WAV; the real captured `whisper-cli-1.9.5-speech.stdout` fed through the output parser; `userMessage` wording; no source file string-matches the error text. Fake `whisper-cli`/`ffmpeg` scripts replay the real captured outputs.
- **Layout**: the CLAUDE.md section lands in `messaging.md`.
- **Integration** (`tests/integration/voice-transcription-route.test.ts`): `GET /voice-transcription` and `/capabilities` through the real HTTP pipeline: local ready, nothing installed, paid configured; `/capabilities` makes no keychain read.
- **E2E** (`tests/e2e/local-voice-transcription-lifecycle.test.ts`): production wiring as in `server.ts`/`AgentServer` — `AppConversationService` with the real `transcribeVoice` dependency transcribes an app voice note through local, labelled `local`; nothing installed → the line carries the missing list. Uses the real `whisper-cli`, `ffmpeg` and model when present on the machine (the Studio), else the fakes. This is the catalog drill.
- **Live proof**: a real Opus voice note sent to a throwaway agent through its Telegram test group, and a real audio clip through the Slack test workspace, with no Groq/OpenAI key in the agent's environment, come back as transcripts produced by the real whisper-cli. Then, after deploy, a real app voice note to Echo (driven by the echo-android-app session) arrives transcribed with provider `local`.

## Maturation plan

- **test-agent-live:** a throwaway agent on the Studio with no Groq/OpenAI key: a real Opus voice note through its Telegram test group and a real audio clip through the Slack test workspace come back transcribed by the real whisper-cli; with whisper hidden, the session receives the plain missing-pieces line.
- **dev-agent-live:** Echo, from the deploy after merge: the echo-android-app session sends a real app voice note and the stored transcript is labelled `local`; `GET /voice-transcription` on each of Echo's machines reads what is installed there.
- **fleet:** on by default with the release, because it only acts where whisper.cpp is installed (an agent without it sees only the clearer failure text), and its off switch is `voiceTranscription.local: false`.
- **graduation criterion:** the three live proofs above pass (Telegram, Slack, app), and in the first week on Echo no degradation report shows an installation-level failure on a machine whose route reads `proven`. A zero count of real voice notes is not a pass.
- **dark-window:** none: the change ships on. If the criterion is not met within 14 days of merge, the reason and a new date go on Echo action ACT-613, never left silently.
- **ladder:** not applicable: ships on by default with the off switch voiceTranscription.local (no stage gate)

## Rollback

Two levers: `voiceTranscription.local: false` restores the old behaviour for transcription (paid only, else "can't read"), with no restart of anything else; reverting the merge also restores the old Slack and WhatsApp code. No state is written (only per-run temp WAVs, removed each time).

## Out of scope

- Preferring local over a configured paid key automatically (the explicit `"local"` setting already gives local only; an automatic preference is for later).
- Server-side automatic install.
- Taking Telegram voice transcription off the polling loop (would let long notes exceed 60 s; a separate change).
- A pool-wide `scope=pool` view of every machine's transcriber.

## Left behind

- Pool-wide transcriber view: held by Echo action ACT-613; the route names its own machine meanwhile.
- Re-transcribing app notes that failed before an install: tracked in the same commitment.
- The status route and `/capabilities` follow Telegram's `voiceProvider`; a Slack-only `audioTranscriptionProvider: "local"` is honoured for Slack notes but not reflected in the status (rare; precision).
- In-process waiters behind another process's run fail as "took too long" at their deadline rather than at once as "busy" (bounded by the budget; only with several agents on one machine).
- Telegram's success path: a throw from logging could fall into the failure path and log a second line (unlikely; handler errors are already caught).
