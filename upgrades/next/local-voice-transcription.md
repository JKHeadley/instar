## What Changed

Voice notes can now be transcribed on the agent's own machine with whisper.cpp, free and with no account (docs/specs/backup-on-machine-voice.md). When no Groq or OpenAI key is set up, the agent uses `whisper-cli` + a ggml model + `ffmpeg` if they are installed; when a paid provider is set up it is still used first, and on any failure the agent falls back to the machine (a 20 s share of the budget is held back so a hanging service still leaves time). `voiceProvider: "local"` makes the machine the only transcriber; `voiceTranscription.local: false` turns it off.

Telegram, the app, Slack and WhatsApp now all use the one shared transcription module (Slack and WhatsApp had their own copies). When a note can't be transcribed, every channel tells the agent the plain reason (for example which pieces are missing), and on Telegram the session receives `[voice] (transcription unavailable: <reason>)` instead of the person getting a canned reply, so the agent answers and can offer to fix it. App transcripts are labelled with the provider that actually produced them.

New `GET /voice-transcription` says which transcriber this machine uses and what is missing; `/capabilities` carries a `voiceTranscription` block. Every agent's instructions gain a "Voice messages and transcription" feature note with the exact install steps (through the awareness entry registry, so existing agents get it on update). The recommended-services catalog's voice row now lists the on-machine transcriber as its tested backup.

Safety: ffmpeg only accepts single-file audio formats and no network; one local run at a time per machine, each with a time limit; silence is measured from the audio, because whisper invents words on silence.

## Evidence

Incident: 2026-11-14 14:21 PST, Justin's Android-app voice note reached Echo as "transcription unavailable" though whisper.cpp was installed on the Studio. After: `tests/unit/voice-transcription-local.test.ts` (35 tests) runs the real ffmpeg + whisper.cpp 1.9.5 on a real Opus voice note on the Studio — "Hello Echo, this is a test voice note about the local transcriber." — measures a real silent note as silent (whisper's own output for it was " you"), and refuses an HLS playlist and a concat list named `.ogg`. The e2e drill `tests/e2e/local-voice-transcription-lifecycle.test.ts` sends an app voice note through the production server wiring and finds the stored transcript labelled `local`. Live proofs on a throwaway agent (Telegram, Slack) are recorded in the PR.

## What to Tell Your User

Your agent can now understand voice notes without any paid service. If the free transcription program is on its computer, voice notes just work, and your audio never leaves the machine. If it isn't installed yet, your agent will tell you exactly what's missing the first time you send one and offer to install it for you; you only need to say yes. If you already use Groq or OpenAI for this, nothing changes, except that when that service has a problem your agent now reads the voice note on its own computer instead of giving up.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| On-machine voice transcription (whisper.cpp) | Automatic when installed and no paid key is set up; ask the agent to install it |
| Backup when a paid transcription service fails | Automatic |
| Which transcriber each machine uses | Ask the agent ("can you hear voice notes?"); it reads `GET /voice-transcription` |
| Keep audio on the machine only | Set `voiceProvider: "local"` (the agent can do it) |
| Turn the on-machine transcriber off | `voiceTranscription.local: false` |
