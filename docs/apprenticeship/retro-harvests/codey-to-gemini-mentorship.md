---
schema: apprenticeship-retro-harvest/v1
instanceType: mentorship
from: codey
to: gemini
framework: gemini-cli
harvestedAt: "2026-06-04"
scopeMode: full
completeness: partial-accepted
acceptedBy: echo
acceptedAt: "2026-06-04"
redaction:
  scrubber: instar-pii-scrub
  findingsRemoved: 0
  scrubbedAt: "2026-06-04"
fidelityReview:
  reviewer: echo
  verdict: faithful
  at: "2026-06-04"
counts:
  lessons: 6
  metaLessons: 5
  processInsights: 3
programNeeds: 3
sourcesCovered:
  ledger:
    read: true
    issueCount: 3
  playbook:
    read: true
    entryCount: 11
  threads:
    - id: "458"
      messagesRead: 0
      truncated: true
    - id: "13435"
      messagesRead: 0
      truncated: true
---

# Retro-Harvest — Echo→Codey bootstrap, carried into Codey→Gemini

*Distilled from the durable differential-oversight record (`.instar/apprenticeship/maiden-voyage-log.md` + 6 `codey-task-*` cycle captures), reviewed before the `codey-to-gemini` mentorship starts. Named gap: harvested from the durable on-disk differential log + cycle captures, not from a raw re-read of the Telegram threads (hence `partial-accepted` + `truncated: true` on the threads). The framework-issue ledger (3 gemini-cli issues) and onboarding playbook (11 entries) were read for coverage.*

## Lessons

- **Mentee capacity is a hard one-shot constraint.** Gemini 429s ("exhausted capacity") under load and cannot sustain multi-turn work without a loop-driver, so the mentee role is bounded to one-shot tasks today (engineer around capacity FIRST, before any semantic work — Cycle 1 hit the wall before a single grounded bullet). Evidence: pr:708, pr:710.
- **The apprentice (codex) hits the multi-turn wall too — but native `/goal` clears it.** Assigned a multi-turn build over a one-shot turn, Codey stalled to 0% CPU after one turn; started via native `/goal` he sustained an entire multi-file build to a merged PR with zero overseer nudges. The codex-autonomous-START "gap" was not a gap — `/goal` is the working mechanism; the brief just has to say "run autonomously." Evidence: pr:709.
- **Coaching persists across cycles.** Cycle 1's miss (the mentee guessed a fallback model that 404'd) was applied UNPROMPTED in Cycle 3 (#708 falls back to the verified default instead of passing an unknown id through) — real evidence the mentee→mentor learning loop closes across cycles. Evidence: pr:708.
- **The unit/integration seam is where the overseer earns their keep.** A config option that is resolved but never reaches the spawned call reads as a capability that isn't there; #708's fallback model was wired but unconsumed, and unit tests covering the policy module in isolation never asserted it reached a real spawn. Trace a config option END-TO-END to a real effect before shipping it. Evidence: pr:708.
- **CI's sharded full-suite is the backstop that catches what BOTH gates miss.** A `resolveCliModelFlag` change made the resolver default-on-unknown, silently overriding an explicit caller/env model and breaking a pass-through contract its own existing test encoded — missed by the apprentice's new tests AND the overseer differential, caught only by the full-suite shard. Defense-in-depth in layers (apprentice-gate → overseer-differential → CI-full-suite) each catches a different class. Evidence: pr:708.
- **A good mentor sets aside non-reasoning issues; the overseer ROUTES them, never discards.** Codey correctly set Gemini's env warnings aside as non-reasoning, but those warnings were real Gemini-agent infra findings (ripgrep unavailable → GrepTool fallback; TERM=dumb / no 256-color → degraded rendering) that belong on the infra backlog, not the floor.

## Meta-lessons

- **Role-coverage drift is the program's #1 failure mode.** An instance silently drifts onto the EASY overseer↔apprentice axis (shipping PRs) while the actual point — the apprentice-as-mentor↔mentee differential — never runs, because the keystone work naturally lives on the easy axis. The fix is structural role-activity visibility, not vigilance: Structure > Willpower applied to the program itself.
- **When reviewing a change to a function, read that function's EXISTING contract/tests, not just the new code.** The overseer praised a constraint as a clean fix without checking it altered the changed function's existing pass-through contract — the durable overseer lesson from the missed `resolveCliModelFlag` regression.
- **The principle for any guard: respect explicit caller intent; constrain only automatic/guessed choices.** The right resolution kept the guessed-fallback constraint (the real fix) but reverted the explicit-model path to pass-through (keeping its existing test green UNCHANGED = the tell it's right).
- **1 bug → multiple durable artifacts is the program working, not overhead.** A single seam bug became a closed PR gap + a durable differential record + a transferable coaching note + a candidate structural check (the unconsumed-config false-capability class). The loop is designed to convert each incident into compounding structure.
- **The overseer as the manual loop-driver does not scale.** It works for one apprentice under the overseer's attention, but the loop-driver (the dark `codexLoopDriver` / the Gemini `need-gem-002` equivalent) is the single biggest leverage point for parallel apprentice-dev — the overseer should set the milestone cadence and review the differential, not re-prompt every turn.

## Process-insights

- **The differential must be captured structurally, not in ephemeral chat.** Cycles, flags, and the differential evaporated in Telegram, defeating the retro-harvest until a durable per-instance record existed; the cycle-capture store (#709) + the markdown log fixed it so the NEXT instance starts ahead of where this one did. Evidence: pr:709.
- **A bounded one-shot mentor pass running ~1h40m with no result is itself an anomaly the loop should catch.** Relying on the overseer to eyeball Telegram silence is willpower; a per-cycle SLA / overdue-cycle signal at the semantic-cycle level (#710) surfaces it structurally. Evidence: pr:710.
- **New-surface friction recurs identically on every framework PR.** Docs-coverage floors, the anti-drift filename list, builtin-manifest regen, the upgrades/next fragment + side-effects artifact, and parallel-PR manifest conflicts hit every time; a "new framework surface" checklist/scaffold would stop each mentee/apprentice rediscovering the gauntlet by trial-and-error.

## What the program needs

- **Enable + harden the loop-driver so a mentee/apprentice sustains a multi-turn build to a PR without the overseer hand-driving each turn.** The `codexLoopDriver` is already built + wired (dark, self-gating on `autonomousSessions.codexLoopDriver`); the enable is a scoped Tier-2 verification (within-group block-precedence vs the review trio, with the unjustified-stop router as the never-strand fallback) + a per-agent observe-first flip on one codex pilot, plus the Gemini `need-gem-002` equivalent.
- **Structural role-activity visibility on an instance** — surface when an axis (e.g. mentor↔mentee) has been dormant past a threshold, so an instance can't read "in progress" while a whole role is unexercised. Likely an `ApprenticeshipProgram` per-instance role-activity field + check, ships off / observe-first.
- **A "new framework surface" checklist or scaffold** (extend the instar-dev skill, or an `instar dev new-surface` helper) so the recurring per-framework gauntlet is captured once instead of re-discovered each onboarding.
