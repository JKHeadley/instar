# Side-Effects Review — Quota pause agent guidance companion

**Version / slug:** `quota-pause-awareness-companion`
**Date:** `2026-10-31`
**Author:** `Echo`
**Second-pass reviewer:** `not required; this changes instruction text and its idempotent migration, not the scheduler authority`

## Summary of the change

The trusted development path adds conditional quota-pause guidance to `src/scaffold/templates.ts` and `src/core/PostUpdateMigrator.ts` and checks fresh, existing, and repeated-update behavior in unit tests. This separates agent-facing instructions from executor PR #2442, whose independent reviewer correctly treats such text from a confined feedback worker as untrusted. The existing `/quota/migration` route and all pause decisions are unchanged.

## Decision-point inventory

- Agent instruction generation — modify — include the new guidance at initialization.
- Existing-agent instruction migration — modify — append the section only when its marker is absent.
- Quota pause decision and status endpoint — pass-through — no runtime authority changes.

## 1. Over-block

No runtime block/allow surface changes. The migration checks only for its exact section marker; an agent with a custom section using that exact marker keeps its own text, which is the intended non-destructive update behavior.

## 2. Under-block

An old agent that never runs an Instar update will not receive the new guidance. The update path is the existing delivery mechanism. The text does not prove the runtime fix is deployed; it says to look for the status field and refuses to infer a live pause from an absent field.

## 3. Level-of-abstraction fit

Agent awareness belongs in the installation template and in-place migration. The quota status endpoint remains the source of truth; instruction text does not decide whether a job runs.

## 4. Signal vs authority compliance

No new heuristic or authority is introduced. The conditional wording directs agents to observed status and leaves the scheduler's programmatic gate in control.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic at a competing-signals decision point is added. The marker check is an idempotent file migration condition, not a judgment about usage or job safety.

## 5. Interactions

- **Shadowing:** the migration appends after existing sections and does not replace custom instructions.
- **Double-fire:** the exact marker prevents duplicate guidance on later updates.
- **Races:** the migration uses the repository's existing single-file update path; this patch adds no shared state.
- **Feedback loops:** reading status does not change quota or scheduler state.

## 6. External surfaces

New and updated agents may tell users more accurate status about a usage-limit pause. No new API, credential, setting, network host, or scheduler action is added. The guidance points to the existing authenticated local route and is conditional until the runtime fix lands.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator action is added. An agent can read the endpoint and explain the result conversationally; the user need not run a command.

## 7. Multi-machine posture (Cross-Machine Coherence)

Each machine receives the same template through release and the same idempotent migration on update. The text does not assert that one machine's quota state applies to another.

## 8. Rollback cost

Reverting the two source edits stops new installs and updates from adding this section; existing guidance already appended remains harmless and conditional. No database or persistent scheduler setting is changed.

## Conclusion

This companion can be reviewed and merged through the trusted development path without treating the confined executor's agent-directed text as safe. It does not resolve the executor's separate audit-record provenance finding.

## Second-pass review (if required)

Not required for this instruction-only change. The focused migration test covers idempotence and the absent-field wording; the runtime pause and executor merge gates remain separate.

## Evidence pointers

- `docs/specs/quota-pause-awareness-companion.eli16.md`.
- `tests/unit/PostUpdateMigrator-quotaPauseAwareness.test.ts` and `tests/unit/feature-delivery-completeness.test.ts`: 230/230 focused tests passed.
- Executor review finding: https://github.com/JKHeadley/instar/pull/2442#issuecomment-6537745039.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is claimed. This change delivers trusted instruction awareness for an existing quota status path.
