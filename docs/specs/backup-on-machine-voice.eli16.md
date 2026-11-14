# Reading voice notes on the agent's own machine, in plain English

When you send your agent a voice note, it sends the audio to Groq or OpenAI to get the words back. Without an account with one of them, your agent can't read the note and can only tell you so.

This plan is for a transcription program that runs on the agent's own computer, so voice notes work with no account and no internet. It also means your audio doesn't have to leave the machine, which some people will want for privacy.

Nothing is built yet. This is a placeholder that keeps the work on the list, with Echo as its owner.

The plan still has to decide:

- which program to use, and what to do on computers too small to run it
- how to fit it in behind the code every channel already uses, so nothing else has to change
- which one wins when a provider is also set up
- how the agent installs it without asking you to do anything

It's finished when a real voice note is read with no provider key and no network, and the catalog stops listing this as a gap.
