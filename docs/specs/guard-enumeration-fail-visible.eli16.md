---
title: "ELI16 — Guard Enumeration Fail-Visible"
slug: "guard-enumeration-fail-visible"
companion-spec: "guard-enumeration-fail-visible.md"
---

# ELI16 overview

## What this is about

Two background watchers keep an eye on leftover work folders. One reclaims the folders
that are finished with. The other shouts if somebody's unsaved work is stranded in a
folder whose session died.

Both of them start by asking git the same question: *what folders are there?* If that
question fails outright — wrong path, blocked command, anything — the code caught the
error and quietly returned an empty answer.

An empty answer looks exactly like good news. Nothing to reclaim. Nothing stranded. So
a watcher that had gone blind and a watcher that was working perfectly produced
identical output, and the blind one was the reassuring kind of blind.

## Why it matters now

This has happened twice in production, for two unrelated reasons.

The first time, a safety guard was blocking the watcher's git commands. That got fixed
— the specific blockage was removed and a test was added for it.

The second time, on 2026-07-29, a configuration setting named a user account that does
not exist on this machine. Same question, different failure, same empty answer. While
that was true, the reaper reported nothing to reclaim while sitting on 73 folders, and
the stranded-work watcher reported nothing stranded while one of those folders held 292
lines of unsaved work on an always-on safety component, untouched for 20 hours.

The first fix addressed the *reason*. The swallow that turns any failure into good news
survived, so the same problem came back wearing a different hat about a month later.

## What already exists

The exact right instinct is already in the same file, a few lines away. The
cleanliness check is deliberately written so that if it *cannot tell* whether a folder
is clean, it treats it as dirty and keeps it. Its comment says a transient failure must
never make a folder look safe to delete.

That reasoning was applied to one signal and not the other.

## What's new

The listing is now allowed to fail loudly, and the status page answers honestly:

- **Before:** "nothing to reclaim" (a number: zero)
- **After:** "I could not look", plus the actual error

The page still loads — it must never break — it just stops claiming to know something
it doesn't.

## The safeguards, in plain terms

Nothing about *what gets deleted* changes. The rules deciding whether a folder is safe
to remove are untouched, and the set of folders eligible for deletion is identical
before and after. The only difference is that a broken watcher now says it is broken
instead of saying everything is fine. This can only ever result in fewer silent states,
never more deletions.

## What you actually need to decide

Whether "a watcher that cannot do its job should say so" is worth changing the shared
enumeration result, both watchers, their status routes, and the guard-status projection,
given that the alternative has now produced a false all-clear twice.

The honest limitation: this does **not** fix the setting that broke it this time. The
watchers assume a particular repository layout that does not hold for every agent, and
that is a separate change. This one makes the next such mistake visible instead of
silently reassuring — it does not prevent it.

Unprompted alerting and machine-readable error codes are separately owned by tracked
commitments. They are intentionally not implied by this implementation: this change makes
the live and historical evidence truthful, while those later capabilities must earn their
own safety and delivery contracts.
