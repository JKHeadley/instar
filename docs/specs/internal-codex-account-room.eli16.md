# Internal Codex checks use the account with room — Plain-English Overview

## The problem in one breath

Instar runs many small background checks: is this message fine to send, did that session really stop, what is this topic about. On most machines they run on Codex's light model. Until now every one of them used the single Codex login that happened to be the machine's default. On 6 November that login on Mama PC ran out for the week. From 8:49 PM every background check there failed, and would have kept failing for four days, while four other Codex accounts on the same machine still had room.

## What already exists

The subscription pool knows every Codex account on the machine and reads how full each one is every few minutes. The Codex check runner already had a slot for "use this account for this call", but nothing filled it. There was also a backup retry that, after a failure, tried one other account. It took the first one listed, even if that one was full too or was the same login under another name.

## What this adds

Each background check now asks the pool which Codex account has the most room right now and runs there. If no account has a fresh reading with room, it uses the default login, as before. The backup retry now skips accounts that are full, skips a second copy of the login that just failed, tries the roomiest first, and never retries the account the check was just given.

## The new pieces

- A small chooser in the pool: the Codex account with the most room, by its latest reading.
- A tiny link file, because the check runners start before the pool exists; until the pool is ready the answer is "use the default".
- Two extra rules in the backup retry: skip full accounts and twin logins.

## The safeguards

- Same framework and same light model: only which Codex login answers changes. Checks never move to Claude because of this.
- Every unclear case (no reading, a reading for a week that has already reset, a broken pool) falls back to the default login, which is exactly the old behavior.
- Only accounts signed in on this machine are used; no login is copied between machines.
- One setting turns it off: `intelligence.codexAccountSelection.enabled: false`.

## What ships when

It ships in the next Instar release and is on by default, on every machine, after a server restart. No migration is needed.

## What you actually need to decide

Nothing. This follows Justin's direction in topic 130742 on 2026-11-07: background checks stay on Codex's light model and must always stay available, and every account should be usable on every machine.
