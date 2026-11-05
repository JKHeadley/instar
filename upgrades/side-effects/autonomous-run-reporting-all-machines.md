# Side-Effects Review — autonomous run reporting on every machine

**Version / slug:** `autonomous-run-reporting-all-machines`
**Date:** 2026-11-05
**Author:** Echo
**Second-pass reviewer:** independent subagent — concurred after suspended-move and stopped-record corrections

## Summary of the change

Tier 1, reversible source fix. The owner machine now starts AutonomousProgressHeartbeat for every local autonomous job, including paused jobs and suspended moves, and first sends after a 30-minute user silence. Later reports use a widening cooldown capped at 90 minutes. Explicitly stopped records are excluded. Legacy fleet-dark and dry-run values cannot disable this contract. Terminal evidence changes the honest wording; missing evidence yields an explicit uncertainty or pause status. The old finite message budget no longer ends reporting for fleet runs. Files: server wiring, component, run enumeration, config/type descriptions, migration awareness, and tests. Review found and closed the suspended-move and stopped-after-pause boundaries before commit.

## Decision-point inventory

- Reporter startup — modified: starts when Telegram exists on each machine, regardless of legacy dev-gate flags.
- Per-run status classification — modified: activity, pause, suspended move, missing session, and unknown output select truthful text.
- One-voice lease, silence clock, and durable cooldown — passed through unchanged.

## 1. Over-block

No block/allow surface. A recent outbound message still suppresses another report. A moved-away local record is held so the destination owner speaks. A suspended move speaks only when the ownership registry confirms this machine still owns the topic.

## 2. Under-block

If the local server or Telegram transport is unavailable, no message can be delivered; send errors remain logged and retried on later ticks. A missing or corrupt run file cannot be classified. These are infrastructure failures, not a reason to leave an otherwise visible run unreported.

## 3. Level-of-abstraction fit

The owner machine has the local run file and session state. This is the right layer to observe local activity and select an honest status; no other machine needs to infer it from a remote topic.

## 4. Signal vs authority compliance

Per [signal vs authority](../../docs/signal-vs-authority.md), the change has no block/allow authority. Output freshness and session liveness are observations used for wording. They cannot silence a registered local run merely because evidence is absent.

## 4b. Judgment-point check

No new static heuristic decides a competing-signals action. The 30-minute floor is a mechanical communication cadence; ambiguous evidence is explicitly labeled unknown.

## 5. Interactions

Normal agent replies reset the silence clock. The shared ProxyCoordinator lease avoids simultaneous automated sends. The old hard budget is ignored only in guaranteed reporting mode; direct callers retain their legacy behavior. The freeze sentinel still handles recovery independently.

## 6. External surfaces

The user sees sparse topic updates or a plain pause/uncertainty message. Legacy `monitoring.autonomousHeartbeat.enabled`, `dryRun`, silence threshold, and cap no longer suppress fleet reporting. The status endpoint exposes the live reporter. The migration updates agent awareness text.

## 7. Multi-machine posture

Machine-local by design: each server enumerates the autonomous run files and session state on its own machine. A source machine with `moved_to` yields to the destination unless `move_suspended_at` is present and the ownership registry confirms local ownership. Suspended records use the real `active:false` file shape; `stopped_at` overrides stale pause or move markers. The canonical topic send path and one-voice lease handle user-facing delivery.

## 8. Rollback cost

A source revert restores the old reporting behavior. The durable counter remains valid and requires no repair; it merely continues to count messages. The agent awareness section written by the migrator may need a later wording correction if the behavior is rolled back.

## Second-pass review

Concur with the review. The reviewer checked real suspended-move files, paused records past their original window, terminal stopped records, local ownership, and the absence of new blocking authority. The two concrete gaps found in earlier passes were fixed and covered by regression tests before this concurrence.

## PR 2788 repair review

Tier 1, reversible repair on fresh origin/main 09e59eb50, package 1.3.1679, origin https://github.com/JKHeadley/instar.git; agent identity configured before edits. No constitution changes. The reporter bootstrap is independent of sharedIntelligence and PromiseBeacon so a missing model provider or failed beacon initialization cannot keep reports dark. New-agent scaffold instructions now match the migration contract. History and ownership lookup errors report internal-only degradation without changing fallback eligibility or adding user alerts. The ConfigDefaults golden map was checked against each literal and shifted by five lines; the silent-fallback baseline remains 494.

Over-block: no new block/allow authority. Unknown suspended-move ownership remains suppressed. Under-block: reporting still needs a live local server, transport and readable durable state; failures remain observable. Layer: bootstrap belongs at the server wiring layer and diagnostics at the failed read. Signal vs authority: observations and diagnostics only, per docs/signal-vs-authority.md; no competing-signals heuristic added. Interactions: PromiseBeacon and PresenceProxy keep their own model gate; reporter still uses the existing one-voice coordinator and durable cooldown. External surfaces: correct live-reporting instructions for new agents; internal-only diagnostics do not add alerts. Multi-machine: existing owner checks and move markers remain; startup no longer depends on a machine's model provider. Rollback: revert source/test/docs; no state migration or lifecycle action.

Independent second pass: reviewer review_2788 concurred after correcting bootstrap isolation and scaffold parity. Regression tests failed before each correction; unknown-owner suspended moves and failed history reads are covered. Targeted verification: 353 tests across six unit files pass; TypeScript check passes. Targeted HTTP integration (2 tests) and lifecycle (6 tests) also pass, using fixtures without real sessions. All 51 lint steps pass. Full suite verification runs through fleet Local Verify. No laptop sessions or test agents started. Review rounds: two for concrete gaps; commit/gate attempts recorded in build summary.

Decision-audit scope repair: the merge-commit gate exemption preserved the older decision record, which did not list the corrected scaffold. A normal traced commit now records that scaffold change. No runtime authority added.
