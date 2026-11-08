# Upgrade Guide — recommended-services-voice-recipe

## What Changed

The fifth recommended-services setup recipe, `voice-v1` (`src/recommended/recipes.ts`), available on every agent after its live proof. After a yes, the setup session asks whose account (the person's own Groq or OpenAI account, or the agent's own), takes any credential through one Secret Drop, and stores the key through `POST /recommended-services/voice-transcription/key` under the vault name `voice_transcription_key`. Its check proves the provider (from the key's prefix: `gsk_` Groq, `sk-` OpenAI) accepts the key and offers its transcription model. Transcription itself now reads that stored key when the server's environment has none: `src/core/VoiceTranscription.ts` gains `registerStoredTranscriptionKey` (registered once in `routes.ts`), used by Telegram and the app through the shared resolver and by the Slack and WhatsApp copies as a fallback. An environment key always wins; an explicit provider is never replaced by the other vendor. The Telegram reply to an unreadable voice note now says in plain words that the agent can set this up, instead of naming environment variables. A switch-off removes only the key setup stored.

## What to Tell Your User

I can set up voice transcription myself now, so I understand your voice notes. Say the word and I'll send you the page to say yes; the only thing I'd need from you is a choice of account, and a key through one secure link if you want it on your own Groq or OpenAI account. Only the audio of your voice notes goes to the provider.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Voice transcription recipe | The person asks, or the offer list; yes on `/dashboard/service-yes?service=voice-transcription` with the PIN |
| Stored transcription key | Read automatically by every voice-note path when no `GROQ_API_KEY`/`OPENAI_API_KEY` is set |

## Evidence

`tests/unit/recommended-services-voice-recipe.test.ts` (prefix detection, stored-key fallback, explicit-vendor rule, check, switch-off, brief), `tests/integration/recommended-services-voice.test.ts` (yes → key → check → transcription uses the stored key → switch-off), `tests/e2e/recommended-services-alive.test.ts` (available through the real wiring), wiring test. Live proof 2026-11-08 00:33–00:38Z on throwaway `recsvc-bw-agent`: ask → explanation + link → yes → setup topic → account choice → one Secret Drop → check pass → a real spoken voice note answered "the magic word is pineapple" → no with switch-off removed the key. Evidence: `.instar/lanes/bitwarden-recipe-1107/voice-*`.
