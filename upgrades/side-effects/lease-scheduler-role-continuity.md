# Side-Effects Review — lease scheduler role continuity

**Version / slug:** `lease-scheduler-role-continuity`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** independent review raised a gate-wait lease race; fixed with a post-gate fence and passing regression test. Concurred on the bounded restart path.

## Summary

Tier 1. Apply the existing bounded role-restart path to every scheduler-enabled lease transition, including agents with a preferred machine. Pause the old holder immediately.

## Decision-point inventory

- Role restart eligibility expands from an optional self-heal policy to the scheduler-enabled invariant. The lease remains the execution authority.
- Restart throttling and request handling are unchanged.

## Over-block

A flapping lease can cause a planned restart at most once per 15 minutes. During the throttle window, a newly promoted standby may have no scheduler; the minute reconciliation retries when eligible. This is a bounded delay, not a permanent silence.

## Under-block

The old holder's scheduler pauses on every demotion, regardless of the restart request. A gate already waiting at demotion is rechecked before claim or spawn. Work already launched before demotion is outside this scheduler admission fix; the existing session and process lifecycle governs it. A missing definition remains outside this step.

## Level of abstraction / signal versus authority

The role event is already the server's transition point. The scheduler starts only through its normal boot construction. The lease provides authority; the restart reconciles process composition. The post-gate read-only check closes the async admission race. No competing heuristic is added at a block/allow decision.

## Interactions and multi-machine posture

Preferred-machine hints and optional self-heal settings do not suppress the reaction to an actual lease change. The change does not modify election, lease renewal, Telegram polling, or git-sync. It does cause one planned server restart on role change for scheduler-enabled agents, bounded by a durable 15-minute stamp.

## External surfaces and rollback

Operators may see one planned restart and a short startup gap after takeover. A scheduler-disabled agent does not request a role restart. Reverting this code restores the prior optional gating. No migration is required.

## Class-Closure Declaration

No new self-action loop: the existing `decideRoleRestart` durable 15-minute stamp and one-minute reconciliation bound restart attempts. Unit and wiring tests check both directions and the throttle edge.

## Second-pass review

Independent reviewer found that a job waiting in an asynchronous gate could pass the old pause/read-only checks before demotion and launch afterward. A post-gate fence and a passing demotion regression close that path. **Concur with the review** after the fix.
