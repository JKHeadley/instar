# Reading voice notes on the agent's own machine, in plain English

When you send your agent a voice note, it sends the audio to Groq or OpenAI to get the words back. Without an account with one of them, your agent couldn't read the note. On 14 November that happened to Justin: his voice note from the Android app came through as "transcription unavailable", even though the computer already had a free transcription program installed that could read it in two seconds.

This change teaches every agent to use that free program, whisper.cpp, which runs on the agent's own computer with no account and no internet.

- If you've set up Groq or OpenAI, the agent uses it first, as before. If that service fails, the agent reads the note on its own computer instead.
- If you haven't set either up, the agent reads the note on its own computer.
- If you want your audio to never leave the computer, the agent can be set to use only the on-machine program.
- If nothing is installed, the agent tells you in one sentence what's missing and offers to install it. Installing is free; your only step is saying yes.

It works the same for Telegram, the app, Slack and WhatsApp, because they all now go through one shared piece of code. The agent can also answer "which transcriber are you using?" from a status page instead of guessing. Every agent, new or already running, learns about all of this through a short note added to its instructions on its next update.

To keep the computer responsive, only one voice note is transcribed on the machine at a time, and each one has a time limit.

It's finished when a real voice note sent to a test agent with no Groq or OpenAI key comes back as text, read by the on-machine program.
