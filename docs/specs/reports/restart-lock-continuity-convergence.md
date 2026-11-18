# Convergence Report — An unplanned restart or a locked screen no longer silently costs a machine its work

## Cross-model review: codex-cli:gpt-6-astra

The GPT-tier review (codex CLI, model gpt-6-astra) ran in all six rounds. A clean-door Claude read (claude-code, claude-opus-5-5) also ran in every round. It is a second read, not a cross-model opinion. Gemini is not signed in on this machine and did not run. In every round, an internal reviewer read the spec against the source on `origin/main` (0ae5dc0b4) and covered the security, scalability, adversarial, integration, decision-classification, Verify-the-State, Self-Heal, decision-completeness and foundation lenses.

## ELI10 Overview

On Nov 17 the operator found four ways a machine stopped doing its work without anyone being told:
- A hand restart of the M5 ended three conversations that were mid-work, and nothing listed them.
- A machine that went away gave no reason.
- A locked screen on a testing machine went unreported.
- The M5's wedge test kept failing after the screen was unlocked.

This design fixes the first three. The fourth was the test itself, and PR 3378 already fixed it.

**After a restart.** Each machine notes, before any cleanup, every session that was running. Once each is confirmed ended, it lists them and marks the ones with open promises. If any of those haven't come back 15 minutes later, the owner gets one note per restart. Bringing them back automatically is the next step.

**Going away.** A machine that shuts down tells the others why and when it expects to return, as a signed message, and they show that reason.

**Locked screens.** A testing machine, or a machine that maintains itself, that stays locked for 10 minutes is reported once.

## Original vs Converged

- **Part A started as automatic revival and was cut to accounting plus one notice.**
  - Rounds 1 to 3 kept finding new failure modes in choosing which sessions to revive: what counts as recent work, when the machine actually went down, and once-per-boot replay.
  - Under "blockers not falling means cut", revival moved to phase 2 (CMT-1940).
  - Phase 1 takes a census before cleanup, lists every ended session, marks open work, and sends one notice per boot.
- **The M5 was assumed to run machine maintenance, and it doesn't.** The round 2 internal reviewer read the M5 directly: machine maintenance is off there, so it has no wedge monitor, restart proof, enrolment or lock reader. The design now:
  - puts the census in the session layer;
  - serves it at its own route, so it also answers when the resume queue is off;
  - moves the lock reader out of the maintenance gate;
  - watches locks on the Local Verify role.
- **Standby machines.** The first draft relied on the boot purge. On a standby the purge is refused (`not-lease-holder`), and sessions are ended later by the exit monitor. The census reads the records themselves, keyed by session id.
- **Away reasons.** These now come only from records the machine wrote:
  - a dispatched restart rung, sent before the restart command runs;
  - a restart request recorded in the last 2 minutes;
  - otherwise `stopping`.

  The record clears when a different server instance answers. Deadlines use the receiver's clock.
- **Locked-screen reports.** One per host episode, kept in a host file under the existing host lock helper. Continuity belongs to the host record, so a restarting agent cannot postpone the report. A crashed reporter's claim is picked up again after 2 minutes. An attended Local Verify coordinator reports only while verification work is waiting.
- **Removed again.** A shutdown snapshot added in round 4 was removed in round 5. A server stop does not end sessions, so the census already sees them, and the snapshot could wrongly attribute sessions to a later restart.

## Iteration Summary

| Iteration | Standards-Conformance Gate | Design findings (internal / codex / clean-door) | Spec changes |
|-----------|----------------------------|-----------------------------------------------|--------------|
| 1 | ran (4 flags) | 6 / 2 / 3 | standby purge skip; evidence clamp; one predicate; LV scope; marker on own line; reasons from records; proof runs on unattributed boots |
| 2 | not re-run | 5 / 3 / 2 | no last-activity field (history provenance); record-based set; restart request survives deletion; M5 has machine maintenance off (lock watch on LV role) |
| 3 | not re-run | 2 / 3 / 2 | all in the revival logic: **cut** part A to census plus listing |
| 4 | not re-run | 3 / 2 / 2 | census route; per-platform boot time; in-memory away map; deadline lock reading; host-level episode; receiver-clock deadline |
| 5 | not re-run | 3 / 3 / 1 | shutdown snapshot **removed**; reuse `parseBootTime` and `hostSemaphoreCore`; stable episode id; pending/delivered claim; named reader |
| 6 | ran (4 flags) | 1 / 2 / 4 | host-record continuity; age shown, never excluded; `?since=` cursor; one notice per boot; send before the restart command; attended-coordinator condition; duplicate-safe away records. Applied as rules within the existing mechanisms; not re-reviewed, at the cap |

The gate was run on round 1 and on the final text. Rounds 2 to 5 used the same three reviewer families, with no gate re-run: unavailable, reason: run only at start and end to save time.

## Proportion

Tier 2. Six rounds, at the cap.

The spec grew from about 120 to about 220 lines. Two cuts kept it from growing further: revival in round 3, and the snapshot in round 5.

The cut should have come one round earlier. Rounds 1 and 2 both showed revival generating new failure modes.

## Chief of Staff fold-ins (approval 2026-11-18, msg 4f877632)

Approved as maintainer, with three fold-ins, all applied:
1. **Self-Heal Before Notify.** The A.5 notice now states that revival is phase 2 and will be attempted first once it exists. A bounded revival attempt in phase 1 was declined, because choosing which sessions to revive safely is what three rounds could not settle.
2. **Judgment Within Floors.** Each lock episode has its own alert key, so the one-hour mute no longer silences later episodes. A floor allows at most 3 per host per hour, and an episode that interrupts Local Verify work always reports.
3. **Never Silently Cut the Data.** A census is kept until the stewardship pass marks it reviewed. A backlog of more than 200 unreviewed files reports loudly and drops nothing.

**Constitution check re-run after the fold-ins:** ran (5 flags).
- **Applied:** a concurrency ceiling of 8 on the `machine-away` sends (Bounded Blast Radius); backoff and pause brakes on the lock-watch loop (No Unbounded Loops).
- **Accepted:**
  - **The Agent Carries the Loop / Self-Heal Before Notify:** both restate the phase-2 revival deferral, which the Chief of Staff allowed under fold-in 1 (tracked under CMT-1940).
  - **Judgment Within Floors:** a lock that blocks Local Verify sooner is already reported by Local Verify's own failure path, so the 10-minute hold applies only to the lock-only report.

## Left behind (accepted, with reason)

- **Phase 1 notifies without a self-heal step first.** The final gate flagged this. It is deliberate, and it follows the parent spec's Part E: with no healing step to wait for, the notice goes directly. Phase 2 makes revival the self-heal and moves the notice after it (CMT-1940).
- **A Mac that requires its password only after a delay reads `unknown`, so it is never reported.** The spec states this gap.
- **Round 6's final edits were not re-reviewed, because round 6 was the cap.** Each one is a rule within an existing mechanism. They add no new mechanism.

## Approval

Not a constitution change. This needs maintainer approval of the converged spec (Chief of Staff) before `/instar-dev` builds it.
