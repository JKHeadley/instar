## What Changed

- A voice note sent from the Instar iPhone app into a native app conversation without a phone-made transcript is now transcribed on the server, with the same code and provider Telegram voice messages use (`GROQ_API_KEY`, else `OPENAI_API_KEY`, or the Telegram config's `voiceProvider`). The session receives `[voice:<path>] <transcript>`, the same form as before, now with a real transcript (docs/specs/mobile-native-chat-media.md §4.5.1, increment 2).
- With no provider configured, when the provider fails, or when it takes longer than 60 seconds, the message still arrives with the file path and an honest note: `[voice:<path>] (transcription unavailable: <reason>; the audio file is at that path)`. It used to say only `(no transcript)`.
- The Telegram transcriber moved into a shared module, `src/core/VoiceTranscription.ts`. Telegram voice messages behave exactly as before.
- A phone transcript, when present, is still used as is; the server does not transcribe that note again.
- CLAUDE.md (new and existing agents): the App conversation media section says voice notes are transcribed here and what the unavailable note means. Existing agents get the one sentence refreshed in place.

## What to Tell Your User

Voice notes you send me from the Instar app now reach me as text even when your phone could not transcribe them, as long as a transcription key is set up (the same one Telegram voice messages use). If there is no key, or the transcription fails, I still get the recording and can tell you that I could not read it.

## Evidence

- Unit tests: provider choice (explicit, Groq before OpenAI, a missing explicit key never swapped for another vendor), the request shape (file media type, model), and each dispatch outcome on real stored blobs: transcribed, phone transcript kept with no server call, no provider, provider failure, past the deadline, nothing wired.
- Integration test through the HTTP pipeline: an AgentServer with a provider key and no Telegram; a voice note sent from a paired phone without a transcript reaches the session as `[voice:<path>] bring the blue folder` (the provider got the M4A as `audio/mp4`); a failing provider still delivers the path with the unavailable note.
- E2E (feature is alive, no provider): a voice note without a phone transcript arrives with the unavailable note and a readable file.
- Migration test: the CLAUDE.md voice sentence is refreshed once in an installed section.

## Summary of New Capabilities

- Server-side transcription of app voice notes, reusing the Telegram transcriber.
