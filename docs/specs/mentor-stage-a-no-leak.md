---
title: Mentor Stage-A — prevent two-hats source-reference leaks at the prompt source
slug: mentor-stage-a-no-leak
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-self-review-2026-05-31
approved: true
approved-by: Echo under the 12h autonomous deploy mandate (self-approved; flagged in PR). Surfaced by the mentorship loop's own §4.3 leak canary — a recurring `stage-a-leak` ledger finding (impactScore ~130) observed firing on essentially every live mentor tick while driving Codey.
approval-note: >
  The mentor's Stage-A compose LLM bleeds general codebase knowledge (source
  paths, file:line, PR/issue numbers, commit SHAs) into the mentee drive-message
  when it assigns a task (e.g. "verify the Project Map — likely in src/server/ or
  src/monitoring/"). detectStageALeak flags exactly those reference shapes as a
  two-hats leak. The existing "you have NO access to their logs/code/internals"
  preamble is too soft — the LLM reads it as "don't claim to have READ their logs"
  and still adds WHERE-in-the-code hints from general knowledge. This adds an
  explicit, targeted constraint matching the exact reference shapes the detector
  flags, preventing the leak at its SOURCE (the right fix vs. loosening the
  detector). It still permits useful WHAT-to-check guidance.
second-pass-required: false
second-pass-status: n/a-small-prompt-constraint-addition-with-instruction-presence-test-both-the-existing-preamble-and-leak-detector-are-untouched
eli16-overview: mentor-stage-a-no-leak.eli16.md
---

# Mentor Stage-A — prevent two-hats source-reference leaks at the prompt source

## The issue, grounded (the mentorship loop's own leak canary)

The Framework-Onboarding Mentor uses a structural "two hats" boundary
(`src/monitoring/MentorStageA.ts`): Stage A composes the mentee drive-message from
ONLY the conversation surface (what a real user could see), with an empty tool
grant. `detectStageALeak` then verifies the composed message contains no "internal
reference" shapes (source paths, `file.ts:line`, PR/issue numbers, git SHAs) absent
from that surface — because a conversation-blind user could not know them, and
naming them robs the mentee of independent discovery.

In live operation (driving Codey), the `stage-a-leak` finding recurred on nearly
every tick (impactScore ~130). Root cause, verified against the composed prompts:
the Stage-A LLM, when it picks `assign-next`, naturally adds WHERE-in-the-code hints
from its general training knowledge — e.g. "Verify the Project Map … likely in
`src/server/` or `src/monitoring/`". The existing preamble
("You have NO access to their logs, code, rollouts, or internals") is too soft: the
LLM honors it as "don't pretend to have read their logs" but still volunteers
general-knowledge code locations. Those `src/...` tokens match `INTERNAL_PATTERNS`
→ a leak hit every time.

## Fix

Add one explicit, targeted instruction to `buildStageAContext` (right after the
"untrusted input" preamble line), matching the exact reference shapes the detector
flags:

> Never name specific source paths, file names, line numbers, PR or issue numbers,
> or commit hashes in your message — a real user could not know these, and naming
> them robs the developer of the discovery. Say WHAT to check or verify, not WHERE
> in the code to look.

This prevents the leak at its source. It is deliberately scoped: it forbids
WHERE-in-the-code references (the leak) while still permitting WHAT-to-check
guidance ("verify the Project Map excludes hidden state dirs"), so the mentor stays
useful.

## Why this is the right layer

- **Prevent, don't loosen.** The alternative — relaxing `detectStageALeak` to allow
  bare directories — would weaken the §4.3 enforcement (the design treats source
  paths as leaks; `INTERNAL_PATTERNS` matches `src/...` deliberately). Fixing the
  compose prompt keeps the detector strict and the canary intact.
- **Detector untouched.** `detectStageALeak`, `INTERNAL_PATTERNS`, and the canary
  are unchanged, so the detector still catches any residual leak (LLM compliance is
  high but not perfect; the finding will simply fire far less often).

## Safety / blast radius

Minimal + contained. One added line in the Stage-A compose prompt
(`buildStageAContext`). No behavior change to the leak detector, the tool grant, the
spawn path, or any non-mentor code. Only mentor-enabled agents are affected, and
only in how the compose LLM is instructed. Reversible by removing the line.

## Migration parity
N/A — code-only, compiled into `dist`; ships in the normal release. No
agent-installed file / config / template change → no `PostUpdateMigrator` pass.

## Agent Awareness
N/A — internal mentor-compose prompt hardening; no new endpoint or capability.

## Test plan
Unit (`tests/unit/MentorStageA.test.ts`, +1): `buildStageAContext` output contains
the no-leak instruction (the exact reference-shape constraint + the WHAT-not-WHERE
clause). The existing buildStageAContext + detectStageALeak + canary tests stay
green (the detector is untouched). `tsc --noEmit` + `npm run lint` clean.
