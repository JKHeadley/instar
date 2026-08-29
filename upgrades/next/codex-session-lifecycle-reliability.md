# Codex Session Lifecycle Reliability

## What Changed

- Added durable, generation-bound inbound-delivery evidence for Codex sessions so a successful terminal write is no longer mistaken for model acceptance.
- Added fail-closed rollout and composer observation, physical-effect fencing, transfer-safe ownership, bounded observer recovery, and framework-process provenance.
- Added production startup readiness and activation gates. Stage B remains dark unless the shipped evidence is signed for the exact package, commit, machine, and configuration after the required live canary; autonomous Stage C recovery remains dark.
- Added migration and agent-awareness coverage for existing installations, plus unit, integration, and production-lifecycle E2E coverage.

## What to Tell Your User

Codex-backed conversations now keep durable proof of whether each inbound message was merely written to the terminal, actually accepted by Codex, or answered. That makes restarts, transfers, outages, and duplicate-session cleanup much safer: uncertain state stays uncertain instead of being guessed, and recovery actions cannot silently replay or retire live work.

The rollout is deliberately gated. The observer activates only after the exact release candidate completes a signed live canary with at least two hours and 50 representative deliveries and no lost inbound messages, duplicate ownership, stale-owner actions, or false terminal classifications. Autonomous recovery remains disabled until its separate maturation gate is satisfied.

## Summary of New Capabilities

- Durable per-delivery Codex acceptance and response evidence.
- Fail-closed handling of ambiguous rollout JSONL or composer state.
- Single-writer fencing for terminal and filesystem effects across transfer or restart.
- Observable startup readiness, backlog, lag, budget exhaustion, and observer health.
- Exact-artifact signed activation evidence and a fleet-dark autonomous-recovery stage.

## Evidence

- Independent side-effects review converged with final code clearance.
- Focused lifecycle coverage passed 49/49 after the bounded-scanner boundary fix.
- Full primary suite passed 3,214 files and 50,391 tests; the additional E2E lane passed 341 files and 3,119 tests, with zero failures.
- Publication remains blocked by `verify-codex-stage-b-release-evidence.mjs` until the exact candidate's signed Stage B canary artifact is embedded.
