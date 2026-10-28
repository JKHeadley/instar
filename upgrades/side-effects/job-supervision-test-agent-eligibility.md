# Side-Effects Review — Job supervision test-agent eligibility

**Slug:** `job-supervision-test-agent-eligibility`  
**Date:** 2026-10-28  
**Author:** Echo  
**Second-pass reviewer:** pending

## Summary of the change

The job-result supervision cohort check now accepts a test agent only when its init-created `throwawayAgent` record has a valid creation time and an unexpired expiry time. `AgentServer` passes the actual config to the check. The change touches `src/scheduler/JobSupervisionRollout.ts` and `src/server/AgentServer.ts`. It is driven by the approved `docs/specs/job-result-supervision-v2.md`. The worktree is on `JKHeadley/instar` at package version 1.3.1494. The code-owned audit and cohort switches remain off.

## Decision-point inventory

- Test-cohort eligibility — modified: verifies the dated throwaway record before the code-owned cohort switch can admit a test agent.
- Development-cohort eligibility — passed through: still requires `developmentAgent === true`.
- Audit and cohort switches — passed through: neither is opened by this change.

## 1. Over-block

A temporary agent created with `--keep`, or one whose expiry record is missing or expired, cannot join the test cohort. That is intentional because this trial requires an expiring throwaway agent. A malformed timestamp is rejected; rerunning `init` with a valid expiry repairs it.

## 2. Under-block

An agent with a forged future expiry record in its local config could satisfy this eligibility check. Also, `instar init --expires-in` can create a valid record outside a temporary project, and `scheduler.allowOnThrowawayAgent: true` can allow scheduled jobs there. Thus this check alone does not prove simulated inputs, no live jobs, or no third-party egress. The test-cohort switch must remain off until a separate launch-isolation gate and observed proof cover those requirements. This check does not authenticate the init record.

## 3. Level-of-abstraction fit

This is an enumerable structural invariant at the rollout boundary: a test agent must have the init record shape and a future expiry. It belongs beside the code-owned cohort switch, not in an LLM result classifier. The existing throwaway-agent lifecycle remains responsible for expiry teardown.

## 4. Signal vs authority compliance

The check has a narrow allow decision, but it validates an explicit configuration invariant rather than interpreting a message or work result. `docs/signal-vs-authority.md` permits hard-invariant validation. It cannot activate a cohort by itself because the code-owned switches remain the authority for admission. No brittle semantic classifier gains blocking power.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals decision point. Record fields and expiry are finite structural eligibility conditions; Jev remains the planned judge of script outcomes.

## 5. Interactions

- **Shadowing:** the eligibility check runs only inside the existing rollout state helper; the audit switch still gates activation.
- **Double-fire:** no scheduler run or worker is started by this change while the code switches are off.
- **Races:** the helper reads `Date.now()` on each call, so a test agent becomes ineligible after expiry even if the server remains alive briefly.
- **Feedback loops:** the helper does not write config or state.

## 6. External surfaces

No user-facing action or external call is added. The `/jobs/triage` rollout state reports `active`, which includes this eligibility condition when a future test cohort is opened; it does not report eligibility separately. There is no persistent schema change. Agents in the fleet remain on the prior runner.

## 6b. Operator-surface quality

No operator surface is changed.

## 7. Multi-machine posture

Machine-local by design: a throwaway record and its expiry describe one agent install on one machine. The pool-wide supervision audit remains a separate read. This change emits no notice, holds no durable state, and generates no URL.

## 8. Rollback cost

Revert and ship a patch. No migration or state repair is needed. The rollout switches are still off, so current fleet behavior does not change during rollback.

## Conclusion

The eligibility fix is narrow and reversible. It removes a type mismatch in a dormant gate; it is not sufficient to open the test cohort. A separate launch-isolation gate and observed proof are required before that switch changes. Focused tests, TypeScript, build, and the full unit suite passed. The full three-tier and CI gates remain required before merge.

## Second-pass review

**Reviewer:** independent eligibility side-effects reviewer. **Independent read: concur after revision.** An expiring record can exist outside a temporary project, and throwaway agents can be configured to run live jobs. The under-block and conclusion above now state the missing isolation proof; the cohort gate remains off.

## Class-Closure Declaration

No agent-authored artifact defect is fixed; this corrects a runtime type mismatch. The unit test covers the recurrence: a boolean or expired record cannot qualify the test cohort.
