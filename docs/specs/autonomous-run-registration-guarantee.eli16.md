# Autonomous-Run Registration Guarantee (GAP-B) — plain-English overview

## What this is

When you tell the agent "go work on this on your own for a few hours" — an
**autonomous run** — the system has machinery that keeps that run alive: if the
agent's session is killed by accident (a restart, a memory squeeze, an idle
timeout), the run is supposed to be *revived* and picked back up where it left
off. That safety net only works for a run the system actually KNOWS is
autonomous. So the gate that decides "is this session a real autonomous run, or
just a normal chat that quietly went idle?" has to answer correctly.

## The problem this fixes

An autonomous run writes down "I'm a live autonomous run for this topic" in a
**per-topic** file — a file named after the conversation it's working in. That
is the canonical, current way runs register themselves; it's the same file the
reaper and the revival machinery read.

But the stop-gate — the thing that answers "is this autonomous?" — was looking in
the WRONG place. It only ever checked one *old* single-file path that an
autonomous run no longer writes. So a properly-registered run was **invisible to
the gate**: the gate said "not autonomous," the run got treated as a plain idle
session, and the whole revive-it-later safety net never engaged. The run died
silently — exactly the failure this whole family of work ("An Autonomous Run Must
Outlive Its Session") exists to prevent.

## The fix (PR1 — the read-path correction)

PR1 makes the gate read the right place, in the right order:

1. **First**, the canonical per-topic file (the one a modern autonomous run
   actually writes). To check it, the gate needs to know which topic the session
   serves — so the server now resolves that itself: it maps the session's
   internal id to its terminal session name, then looks that name up in the
   topic-to-session registry (the very same lookup the existing stop hook uses).
2. **If that comes up empty**, it falls back to the two older single-file paths.

So whether or not the topic resolves, the gate now finds a registration that
exists.

## The safety property (no silent "not autonomous")

The load-bearing guarantee: a lookup that **misses** — no session record, a
corrupt registry, an unknown name — is NEVER treated as "this is not an
autonomous run." A miss explicitly falls through to the legacy paths and only
returns "not autonomous" when *none* of the three paths show a registration.
The miss case is handled out in the open and is covered by tests on **both**
sides of the boundary (a miss that still has a legacy file stays true; a miss
with no file is the genuinely-inactive case). The gate can only ever become MORE
accurate, never falsely negative.

## What this does NOT do (and what comes next)

PR1 is the deterministic read-path fix only — it makes the gate SEE a
registration that already exists on disk. It does not make the agent
auto-write that registration in the first place. The registration-guard that
auto-writes a stub when a run starts without one is a distinct, dev-gated change
specified separately in the spec's PR2 section. PR1 ships live; the auto-write
guard rides its own sign-off.
