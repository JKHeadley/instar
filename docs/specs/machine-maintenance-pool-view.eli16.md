# Machine maintenance pool view — plain-English overview

## What this change is

Each of Justin's machines already keeps a small, watch-only record about itself: how long it has been up, what a nightly restart would have done if one were allowed, whether its screen is really locked, and which browser windows the agent left open. Until now you could only read that record by asking the one machine you happened to be talking to. If you wanted to know about the Mac Mini, you had to be on the Mac Mini.

This change adds one switch to the two existing questions: add `?scope=pool` and the machine you ask goes and collects the same answer from every other online machine, then hands back one combined answer where every entry says which machine it came from, by its name.

## What already exists

- `GET /machine-maintenance` and `GET /machine-maintenance/lock-state` on each machine (watch-only; nothing restarts or closes).
- A standard way for one machine to ask its siblings a question over the private network, with a shared short-term cache so a busy dashboard does not ask the same machine over and over.
- The console's Machines page, which showed one "restart care" line for the machine you were on.

## What is new

- Both routes accept `?scope=pool`. The answer lists each machine that replied, tagged with its id and name. A machine that could not be read is listed separately with a short reason in plain words: offline, turned off there, on an older version, did not answer, and so on. The reason never includes the machine's address or any password or token.
- The Machines page in the console now asks for the pool view and shows each machine's restart-care line on that machine's own card, plus one line saying which machines it could not read and why. It still fits a phone screen.

## The safeguards

- Read-only. The combined answer says, at the top, that it has no authority and can neither restart nor stop anything. Nothing in it can be used to approve or start a restart or close a browser.
- One slow or broken machine never breaks the whole answer: it becomes a "can't tell" row, never an error page.
- A machine on an older version simply shows as "older version"; nothing has to be upgraded first.
- The agent's API token is only sent over connections the existing safety check allows.

## What you need to decide

Nothing. This is a read-only view over records that already exist. If it ever looks wrong, removing it changes nothing else.
