# Convergence Report — Telegram login UX narrative-driven prompt

## ELI10 Overview

v1.2.17 made Codex+Playwright the primary Telegram setup path. It
worked technically — Codex opened the browser and started watching
for login. But the user saw a QR code with no on-screen guidance.
The Claude version of this flow doesn't have this problem because
the wizard skill explicitly tells Claude to narrate to the user.
The Codex prompt I wrote for v1.2.17 didn't.

This PR rewrites the Codex prompt with explicit conversational
rules at the top + step-by-step instructions to print user-facing
narration. Also bumps the login-wait from 2 minutes to 5 minutes
for fresh users who need to install Telegram on their phone first.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self + Justin's log + "why pre-spawn?" pushback | 2 | conversational-rules preamble + step narration |
| 2         | (converged)           | 0                 | none |

## Original vs Converged

The original draft of this fix proposed scaffolding the instructions
from instar BEFORE the spawn (pre-spawn console.log block).
Justin's pushback: *"why cant the codex agent know to stop just
like the claude code agent does?"* — same way Claude follows the
wizard SKILL.md's behavioral instructions, Codex can follow
prompt instructions, if the prompt actually asks for it. The
right fix is prompt content, not pre-spawn scaffolding.

The converged design moves all user-facing narration INTO the
prompt with explicit "you are talking to a real person sitting at
the terminal RIGHT NOW" framing. No pre-spawn scaffolding.

## Full Findings Catalog

**Finding 1 — Codex silently polled because the prompt didn't ask
for user narration.**

- Severity: high (real user, real install, real failure).
- Resolution: new "CRITICAL CONVERSATIONAL RULES" section at the
  top of the prompt + step-2 prints an explicit instruction block
  + step-3 prints reminder messages every 25-30s during the wait.

**Finding 2 — 120s login window was too short for fresh users.**

- Severity: medium (some users will need to install Telegram on
  their phone first; 2 min isn't enough).
- Resolution: prompt now specifies 5-minute window (300s) with
  60 poll attempts at 5-second cadence. Outer spawn timeout
  remains 10 minutes in case Codex hangs.

## Convergence verdict

Converged at iteration 2. Pure prompt-content change; no new
modules, abstractions, or authorities. The verifier still
authoritatively decides whether the agentic path succeeded. 20
unit tests (18 from v1.2.17 + 2 new for the conversational rules
and 5-minute window).
