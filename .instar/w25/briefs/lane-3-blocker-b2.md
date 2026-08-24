# W25 LANE 3 — BLOCKER B-2: what is actually LOADED, not what is on disk

## Your job, and its exact boundary

Enumerate the hook registrations actually LOADED inside every RUNNING session on this machine,
and record that population as release evidence. This is a BOUNDED PROOF, NOT A REBUILD. You are
counting, with controls. You are not fixing anything you find.

## Why it blocks the release

A guard that is on disk and not loaded is not a guard. Claude Code reads `.claude/settings.json`
ONCE, at session start — so a session launched before a hook existed never runs it, and the file
on disk tells you nothing about the process. This window is about to deploy code into a running
system; knowing which safety hooks are genuinely live in each session is a precondition, not a
nice-to-have.

There is a specific claim to test rather than assume: on 2026-08-23 at ~18:51Z the registration
count was restored from 19 to 36, and the expectation on record is that **both restarted sessions
should carry 36**. The settings file was then written AGAIN at ~18:59Z with identical content,
and it is not established who wrote it. Your count either corroborates the 36 or it does not.
Either result is a real answer. Do not reach for 36.

## The distinction that is the whole point

`on disk` ≠ `loaded in this process`. Report them as SEPARATE columns per session, and where they
differ, say so plainly. A session whose loaded count is lower than the file's count is a session
running with less protection than the machine appears to have — that is the finding this blocker
exists to surface.

Name your control: something that would have let you tell a genuinely-loaded hook from a merely
present one. If you cannot establish loaded-ness for a given session, that session is `unmeasured`
— which is NOT the same as "it has none", and NOT the same as "it matches the file". W24's whole
subject was instruments that collapse those three, so do not do it here.

## Scope

Every running session on this machine — `GET /sessions` is the census; there were 5–6 at 21:30Z.
Include the long-lived ones. Also read `GET /guards` for the machine's own posture claim and say
whether it agrees with what you measured per session; a disagreement between the posture surface
and the live sessions is worth more than either number alone.

If a session cannot be inspected without disturbing it, DO NOT DISTURB IT. Report it as
unmeasured with the reason. Nothing here is worth interrupting live work for.

## What you must NOT do

Do not restart, refresh, nudge, or kill any session. Do not edit `.claude/settings.json`. Do not
apply the unapplied guard patch at `.instar/w24/recovery/settings.RESTORED.json` — that decision
is Justin's and remains open. No push, no merge, no deploy. You are a measurement, not a repair.

## Report to

`/Users/dabombstudio/.instar/agents/echo/.instar/w25/lane-3-blocker-b2.md` — write as you go.
Include: a per-session table of on-disk vs loaded counts with your control; whether the 36 claim
holds; what the posture surface says and whether it agrees; and every session you could not
measure, with the reason.
