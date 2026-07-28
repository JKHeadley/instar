# ELI16 — Every framework must show its "how sessions get stuck" homework before onboarding

## What this actually is

An AI agent session can get stuck in a small, countable number of ways: the turn ends
normally, the session dies mid-sentence when its server restarts, it sits at a prompt
ignoring new messages, its conversation gets poisoned so every reply errors, a content
filter rejects everything, it hits a usage limit, it wedges on an approval prompt no
one can answer remotely, or it runs out of context window. (A whole machine going dark is the multi-machine
layer's job, so it's recorded as a cause tag on whichever stuck state the session
lands in, not as its own category.)

We learned that list the expensive way — one silent production stall at a time, each
discovered only when it happened. The latest one (defect #9, Jul 17): a codex-based
agent's own keep-working loop covered exactly the stall types its author had personally
seen and silently missed the "interrupted mid-turn" case, so the agent sat frozen for
two hours while the system reported it as "running."

This spec makes the list itself official. There is one canonical registry of
session-stop classes in code, and every framework being onboarded onto Instar must
file a coverage matrix: for each stall class, either name the exact detector and
recovery machinery that handles it (with a test proving the detector actually fires),
or explicitly declare "we have a gap here" with a tracked plan to close it, or prove
the class can't happen for that framework by construction. Blank cells are not allowed.

## What already exists

Claude-based agents accumulated a whole family of stall watchers over months (the
silent-freeze watchdog, the wedged-context sentinel, the approval-prompt floor, the
resume queue). Codex-based agents inherit almost none of it — recovery is hand-rolled
per framework, with per-author blind spots. The apprenticeship program already has
gates on onboarding transitions; this plugs into those existing gates.

## What's new

- A machine-readable class registry (`src/data/stall-classes.ts`) so code and docs
  can't drift apart.
- One matrix file per framework with strict, checkable statuses: covered /
  covered-but-dark / declared-gap / not-applicable.
- One validator, run in two places: CI re-checks every matrix on every push (so a
  renamed detector or a new stall class turns stale matrices red immediately), and the
  apprenticeship onboarding gate refuses sign-off on an incomplete matrix.
- Seed matrices for ALL FOUR frameworks: claude-code (writing down what exists,
  honestly marking what ships dark), codex-cli (honest zeros, each gap filed as a
  tracked issue), and gemini-cli/pi-cli (honest "nothing here yet" files — one is
  dead upstream, one ships dark — so the enumeration has no missing frameworks).
- Hardened plumbing from review: file paths named in a matrix are jailed inside the
  repo (no reaching outside the tree), evidence files must actually name the detector
  and the stall class they prove (pointing at any old green test doesn't count), and
  every gap's "plan to close it" link is checked to still be alive at sign-off time.

## Safeguards in plain terms

The machine only checks what a machine can check: the rows exist, the named files
exist, the tests exist. Whether a "covered" claim is genuinely true stays a human-level
judgment — a human (authenticated separately from the agent asking for sign-off, so
no one approves their own homework) must explicitly accept every declared gap, every
"not applicable" claim, AND every "covered" claim at sign-off; the report enumerates
all of them so nothing passes silently. A "not applicable" claim that later produces
a real incident raises an alert plus a proposed fix-up for a human to approve —
nothing rewrites the records by itself. A human sign-off is a real one-time-use
approval tied to the exact version of the document approved (approve-then-edit voids
it, and an agent-written claim that "the operator approved this" counts for nothing
without it). A small weekly self-check job re-verifies the live parts of every
matrix — including the four starter ones that would otherwise never be re-checked —
so a promise that rots gets flagged within days, not at the next onboarding. The gate
ships in dry-run first (it logs what it would refuse before it refuses anything), and
turning it off just leaves the matrices as ordinary documents.

## What you actually need to decide

Whether the standard is right: no framework onboards without showing its complete
stall-coverage homework, and growth of the class list automatically becomes visible
debt in every existing matrix instead of a silent blind spot.
