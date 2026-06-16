# ELI16 — Autonomous registration guarantee

## What this is, in plain English

When you tell me "go autonomous and work overnight," there's a setup step that
**registers** the run — it writes a little state file that the rest of the system
watches. If that run is registered and my session gets reaped (the housekeeping
reaper kills idle/old sessions to free resources), a previously-shipped feature
(#1174/#1157) automatically **revives** it: it sees the state file, marks the
session as "doing real autonomous work," and respawns it where it left off. Good.

The hole: that setup step is **something I have to remember to do**. If you say
"go" and I dive straight into the work without running the registration step,
there's no state file — so when the reaper hits my session, it looks like any
idle session and **dies silently**, hours of work gone. That's exactly what
happened on 2026-06-14.

You can't fix this in the autonomous stop-hook, because if the run was never
registered, the hook was never installed either — there's nothing there to catch
it. The only thing that runs no matter what is the **reaper**. So this change
teaches the reaper a second way to recognize "this session is doing real work,
don't let it die quietly": a **fresh open commitment** for that conversation.

A "commitment" is a durable promise I made you ("I'll report back when X"). If a
session has a fresh open promise on its topic, that's strong evidence it's alive
and working — so the reaper now treats it the same as a registered run and
revives it, **even with no state file**. And when that happens, I also raise one
quiet flag ("this run is doing committed work but isn't registered — register
it") so the gap gets noticed and closed, not papered over.

## What already exists vs what's new

- **Already exists (untouched):** the whole revival machinery — `evidenceEligible`,
  the `build-or-autonomous-active` evidence, the ResumeQueue drainer that
  respawns a reaped session, the work-evidence staleness gate (#1125). A
  registered run behaves exactly as before.
- **New:** (Part B) a tiny `getActiveByTopicId` helper + an additive evidence
  source in the reaped-session wiring — if there's no state file but there's a
  fresh open commitment for the topic, inject the same revival evidence. (Part A)
  one deduped observe-only signal that the run is unregistered. (Part C) a small
  read-path fix so a hot-path heuristic reads the per-topic state file like
  everything else.

## The safeguards, in plain terms

- **It's additive, not a replacement.** The state-file path is untouched; the
  commitment path is an OR alongside it. Nothing that worked before changes.
- **It agrees with the kill decision (the anti-loop rule).** A near-identical
  idea once caused 13 sessions to be killed-then-revived in an endless loop,
  because the "keep alive" check and the "revive" check disagreed about what an
  open promise meant. This design forces them to **agree**: the revive only fires
  when the keep-guard's own condition (a fresh promise *and* recent activity from
  you) holds — so a promise that wouldn't keep a session alive can't revive it
  either.
- **It's bounded.** Only a *fresh* promise (dated within 6h, measured from when
  it was made — automated heartbeats can't refresh it), only an *active* promise
  (not failed, not waiting on you), and the existing cap stops any revive-loop
  after 2 tries.
- **It's a signal, not a new gate.** The promise only *feeds* the existing
  eligibility decision; it holds no blocking authority. Part A never blocks
  anything — it just makes the invisible visible.
- **It ships dark + dry-run**, like the rest of the ResumeQueue work, so it can
  soak before it ever changes a real revival decision.
- **It's honest about its limits.** It's a *backstop*: it saves an unregistered
  run that made you a promise. A run that made no promise still isn't covered —
  closing that fully (auto-registering the run when you say "go") is a tracked
  follow-up, not pretended-done here.

## What you need to decide

Nothing irreversible. It's a dark, dry-run-first, additive signal into machinery
that already exists. The one tunable is the freshness window (default 6h),
reversible in config. The point is simply: a real autonomous run should survive
the reaper **even when I forgot to register it** — because a promise I made you
is itself proof the work is live.
