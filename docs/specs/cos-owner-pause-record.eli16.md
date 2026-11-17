# Pausing a tracked project — Plain-English Overview

> The one-line version: when the owner asks to pause a project the Chief of Staff tracks, the agent sends them one Telegram button showing their own words, and only the owner's tap pauses it. The agent can never pause work by itself and say the owner asked.

## The problem

The Chief of Staff watches each tracked project. If a project looks stuck, it restarts or nudges the session working on it. On 13 November Justin wrote "lets pause the Instar 2.0 work again until we get our throughput issues solved". The Chief of Staff had nowhere to record that, so it kept checking the project and could restart the very work Justin stopped. The Projects screen can already show "Paused", but nothing could ever set it.

## What already exists

- The Chief of Staff's shared record, which every machine keeps a copy of. Owner actions such as "Unpark" and "Confirm done" are already stored there, and they already come from Telegram buttons that only the owner can press.
- The "paper trail" checker, which can take a reference like `[source: telegram 102965/142745 2026-11-13]`, find that exact message in the logs, and say who sent it and whether a person (not the agent) wrote it.

## What this adds

- **An ask.** When the owner says "pause X" in chat, the agent cites that message. The server checks it really is the owner's own message, then sends the owner one Telegram message: their whole message, the project's name, what pausing does, and a "Pause" button. A resume works the same way.
- **The tap decides.** Only the owner's tap on that exact message pauses or resumes the project. A button on any other message, a tap from anyone else, or the same button pressed twice does nothing new.
- **What a pause stops.** No more checks, no restarts, no nudges, and no reviving a run the Chief of Staff started. A session already running keeps going until it ends, and runs the owner started themselves are not touched. Every note that goes out anyway reminds the owner what is paused and since when.
- **Honest answers.** The owner sees "Paused" only after it is safely saved. If saving fails, or their message was edited since, they are told plainly and nothing changes.

## The safeguards in plain terms

The agent cannot pause work it would rather not do and blame the owner: it can only ask, it must quote the owner's real words, and the decision is the owner's tap. The dashboard PIN does not count, because any session with the agent's API key can read it.

## What changed during review

The first draft let a cited chat message pause the project directly. Reviewers showed an old "pause" message could be re-cited after the owner had said "go again", so the decision moved to a fresh tap. Reviewers also found that older machines would choke on the new record and that a plain revert would silently undo pauses, so the store now ignores record types it doesn't know, and rollback is a switch that stops new pause asks while existing pauses hold.

## What to decide

Maintainer approval (the Chief of Staff session, as Echo the maintainer). One thing differs from the brief: setting the Instar 2.0 pause now needs one tap from Justin on the button, because a three-day-old conditional message is exactly the case where "is this still meant now?" matters.
