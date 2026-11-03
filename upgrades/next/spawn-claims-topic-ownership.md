<!-- bump: patch -->

## What Changed

Starting a session for a conversation directly (`POST /sessions/spawn` with a `topicId`) now records this machine as the conversation's owner in the session pool. Before, that call bound the session only locally. Other machines then read the conversation as unowned and started a second copy when the user wrote next. The record goes through the same place-then-claim step the automatic restart already used. It never takes a conversation another machine already owns. The 201 response reports what happened in a new `ownership` field.

`POST /pool/transfer` no longer counts an autonomous run that is on the transfer's target machine. Moving a conversation to the machine already running its build no longer asks to pause that build, and the move doesn't suspend it. A run on the machine the conversation is leaving still needs confirmation, as before.

## What to Tell Your User

When I start a working session for one of our conversations on one of my machines, my other machines now know that session has the conversation. Your next message goes to it instead of starting a second copy somewhere else. If a conversation ever lands on the wrong machine, I can move it back to the machine running its build without pausing the build.

## Summary of New Capabilities

- Topic-bound spawns record pool ownership, and the spawn response reports the outcome (`claimed`, `already-owned`, `in-flight`, `owned-elsewhere`, `lost`, `dark`, `error`, `unwired`).
- Moving a topic to the machine that runs its autonomous build keeps that build running.

## Evidence

Reproduced live on 2026-11-03. A topic-bound spawn on the Mac Studio for topic 10000001485 answered `GET /pool/placement` with `owner:null, reason:unowned` while its session ran. Topic 136774 had a Studio build session plus a second Mama PC copy, and the duplicate reconciler escalated it as `rule2-rule3-contradiction` instead of converging. New tests: unit tests for the claim action against a real ownership registry, route tests for `POST /sessions/spawn` (claimed, peer-owned, no topic, unwired, plus a wiring check), and transfer tests for a run on the target compared with a run on the leaving machine.
