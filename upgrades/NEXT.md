# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Framework-Onboarding Mentor System — Stage-A two-hats boundary + leakage detector (§19.3).**
Adds the structural pieces that make the mentor's "two hats" real instead of a prompt promise. When
the mentor drives a mentee agent conversationally ("Stage A"), it must be blind to the mentee's
internals so real-world problems surface. This release supplies: an **empty tool grant** for the
Stage-A sub-agent (the conversation surface is injected into its prompt, so it needs — and gets —
no log/code/rollout/filesystem tools at all; enforced by the CLI `--allowedTools`, not a hook), a
**context builder** whose signature *is* the boundary (there is no parameter through which an
internal can enter), and a **leakage detector** that scans each Stage-A transcript for references
to internals it could not have seen, with a built-in positive-control canary so the detector itself
can't silently rot.

Pure logic, fully unit-tested, with no production caller yet — the scheduled mentor job that uses
these ships in a later staged PR. Off by default; nothing activates.

## What to Tell Your User

- The "play the user" half of the mentor now has a real, structural blindfold — it literally has no
  tools to peek at the mentee's internals, plus a tripwire that flags any peeking, self-tested so a
  broken tripwire can't masquerade as "all clean."
- Still dormant; nothing changes day-to-day.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stage-A tool grant | `STAGE_A_ALLOWED_TOOLS` (empty) passed to `spawnSession({ allowedTools })` — structural "conversation only" |
| Stage-A context builder | `buildStageAContext(surface)` — prompt from the conversation surface only |
| Leakage detector | `detectStageALeak(transcript, surface)` + `runLeakCanary()` — flags internals references the mentor couldn't have seen |

## Evidence

Net-new feature, not a bug fix — no prior failure to reproduce. Behavior is proven by tests: the
leakage detector ships with a **positive-control canary** (a synthetic transcript citing
`src/...Retry.ts:142` and `PR #999` against a surface that contains neither) that the detector MUST
flag — so a dead/no-op detector is distinguishable from a clean run — plus negative tests proving
clean conversational prose and user-supplied references do NOT trip it. 12 unit tests; affected
push-config suite green vs canonical main.
