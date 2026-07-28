# Durable outbound dedup — Plain-English Overview

> One line: Echo already avoids sending the same message twice — but it remembered "what I just sent" only in memory, so a restart wiped that memory and the same reply could go out several times. This writes that memory to disk, so it survives a restart.

## The problem (the duplicate messages Justin spotted)

During the "server temporarily down" instability, a red-team test message hit Echo right as the server was restarting. The same reply went out **5 times, byte-for-byte identical**, within 19 seconds. Echo has a duplicate-suppressor, but it kept its "recently sent" list purely in memory — and a restart (or two server processes briefly overlapping during the churn) means that in-memory list is empty/split, so the repeats slipped through.

## What this adds

A small on-disk store for the duplicate-suppressor's fingerprints. Now when Echo is about to send a reply, it checks both its in-memory list AND the on-disk record — so an identical reply sent moments ago is caught even if the server restarted in between.

## The most important safeguard: fail-open

A duplicate-suppressor that *wrongly* blocks a real reply is worse than the duplicate it prevents. So the on-disk store can never block a send: if the database is missing, locked, corrupt, or its native library is broken, every operation quietly does nothing and Echo falls back to exactly the old in-memory behavior. It can only ever *add* a catch, never drop a legitimate message. (The native-database fragility was itself part of this incident, so even opening the store is guarded.)

## What it does NOT do

- It only catches *byte-identical* recent repeats to the same topic (which is what the bug was — verified identical). It deliberately won't touch different text, a different topic, brief acks (under 40 chars), or anything outside the time window.
- It catches the duplicate *send*; a deeper guard to stop the message from being *re-processed* across a restart in the first place is noted as a follow-up.

## Housekeeping

The on-disk store also registers itself to be closed cleanly when the server shuts
down (so it never leaks a database handle — good hygiene, and on-theme for an
incident about resource usage). The route test that exercises this was given its own
private temp folder per run, since the new on-disk memory would otherwise carry over
between test cases.

## Evidence

`tests/unit/outbound-dedup-durable.test.ts` (6 tests): catches a duplicate across a simulated restart (fresh instance, same db file — the actual bug); in-memory still works; different text/topic/past-window are NOT suppressed; fail-open on a throwing store and on an unwritable path. The existing dedup tests (11) still pass; `tsc` clean. causalAutopsy: the dedup state was in-memory-only, which the restart churn (this incident) exposed.
