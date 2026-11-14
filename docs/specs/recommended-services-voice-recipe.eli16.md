# Your agent can set up voice transcription for itself, so it understands your voice notes

## What this is

When you send your agent a voice note, it needs an outside service to turn the audio into text. Two work: Groq, which is fast and has a free tier, and OpenAI, which charges a little per minute. Until now the only way to switch this on was for someone to put a key into the agent's launch settings by hand, and an agent without one replied by telling you to "set GROQ_API_KEY in your environment", which is a chore no person should be handed.

Voice transcription is one of the recommended services. This change adds its setup recipe: after your yes, a setup session gets a key and stores it in the agent's own encrypted vault, and every place that reads voice notes (Telegram, Slack, WhatsApp, the app) now finds that key there. It was proven live on a test agent over real Telegram on 2026-11-08, and this change marks it available on every agent.

## What the setup session does

It asks whose account to use, and presents both as good options: your own Groq or OpenAI account, which it manages for you, or an account of the agent's own. Any credential it needs comes through one secure form, never through chat. It stores the key without printing it, then runs the check: the provider must accept the key and offer its transcription model. When that passes it tells you voice notes now work and invites you to send one.

## What changed for an agent that can't read voice notes

On Telegram, its reply to a voice note now says, in plain words, that it can't read voice notes yet and that it can set that up with one yes from you. No commands, no settings.

## How it was proven

On a fresh test agent, as the person: asked for it; the agent explained it and sent the yes page; after the yes, its setup conversation asked one decision (whose account) and sent one secure form; it stored the key, passed its check and said so; then a real spoken voice note was sent, and the agent answered with what it said. A no with switch-off removed the key.

## Safeguards

- The key lives in the agent's encrypted vault and is never printed, logged or sent in a message.
- A key you put in the launch settings yourself always wins, and a switch-off never touches it: setup removes only the key it stored.
- If you named one provider, a key for the other is never used in its place.
- The check says "unknown" when the provider does not answer, so nothing claims to work on a guess.
- Only the audio of your voice notes goes to the provider.

## What you need to decide

Nothing. Voice transcription is available the same way as the other four services: ask your agent, or answer its list, and say yes with your PIN.
