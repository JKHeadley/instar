---
title: "Reading voice notes on the agent's own machine"
slug: "backup-on-machine-voice"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "backup-on-machine-voice.eli16.md"
related-specs: "recommended-services.md"
status: "stub"
---

# Reading voice notes on the agent's own machine

Owner: Echo. Third in the backup work order (`recommended-services.md`, Frontloaded Decisions). Closes the `gap` on the `voice-transcription` row.

## Problem statement

`VoiceTranscription` calls Groq or OpenAI. With neither key, a voice note can't be read, and the agent can only say so.

## Acceptance

With no provider key and no network, a voice note is read on the machine, through the same shared wrapper every channel uses. A drill proves it with real audio, and the catalog row moves off `gap`.

## Questions this spec must answer

- Which transcription engine and model size, and what happens on machines too small to run it.
- How it fits behind `VoiceTranscription` so no channel changes, and which is preferred when a provider key also exists, since keeping audio on the machine is also a privacy benefit.
- How the agent installs it with no steps for the person.

## Status

Stub. Not reviewed or approved, and nothing is built.
