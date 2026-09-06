# WINDOW 32 CHARTER — “Make active mean alive”

Status: **APPROVED by Justin in topic 36966 at 2026-09-05 00:49 PDT.** This charter preserves the approved proposal's scope, exit test, lanes, and exclusions without expansion.

## Plan-tree placement

Top goal: an agent that catches and fixes its own mistakes inside approved rules while needing Justin less.

Branch D: the machinery that reports on the machinery must tell the truth.

Current leaf: W31 repaired the lifecycle checker but failed because the surrounding continuation/supervision control plane stayed green while execution was dead. W32 addresses that exact false-green seam before any broad evidence-engine work resumes.

## Ceiling and close rule

24 hours is a ceiling, not a duration. There is no separate soak. The window closes immediately when the live adversarial exit test and close receipts pass. If they do not pass by the ceiling, it closes as failed.

## Centerpiece

Build and live-prove one authoritative run-liveness state machine. `active` is allowed only while all required predicates are true:

1. A real executor is bound and running.
2. Its heartbeat is fresh.
3. Its delivery path is reachable.
4. Durable work evidence has advanced within the declared interval.
5. The window is admitted beyond `pre_start_gate` and has not expired.

A missing predicate moves the run to `at-risk`. One bounded recovery attempt may occur. Recovery success returns it to active with an attributable receipt; failure moves it to `stalled` or `failed`. No state may remain green from registration alone.

## Live exit test

All must pass:

1. Three consecutive 30-minute cadence intervals each produce an advancing durable receipt.
2. After interval one, deliberately end the active executor/turn.
3. Without Justin prompting, the system detects the loss and either resumes exactly once from the first unreceipted task or marks the run failed loudly within 15 minutes.
4. Every report due during the window is delivered; if the window lasts three hours, the three-hour synthesis must arrive without observer intervention.
5. Zero sampled minutes are labeled `active` while any required liveness predicate is false.
6. The lifecycle leaves `pre_start_gate` before substantive execution.
7. At expiry or close, recurring-duty materialization stops immediately, the final snapshot freezes, and active is revoked. Zero post-ceiling duties are created.
8. A second observer independently verifies the induced loss, state transitions, recovery cardinality, receipts, and Telegram delivery.

## Work lanes

- Lane A — state model and single authority: Codey worker in a proper Instar worktree; implement through full source discipline.
- Lane B — cadence/report executor across turn boundaries: separate Codey worker.
- Lane C — expiry freeze and recurrence stop: separate Codey worker.
- Lane D — independent adversarial test and evidence verification: Observer 2 / GPT-5.6-Sol; does not share the builders’ method.
- Observer 1 remains high-level: orchestrates, verifies receipts, reports plainly, and does not become the builder.

Use both available machines where live verification permits. A machine that is offline is recorded as a refusal, never silently omitted.

## Engineering requirements

- Structural enforcement, not prompt reminders.
- Unit, integration, and production-path E2E lifecycle tests, including dependency-wiring integrity and both sides of every liveness transition.
- Agent-awareness template update for the new state/read surface.
- Idempotent migration for existing agents if installed configuration, hooks, scripts, or templates change.
- Dark/observe-first rollout until the adversarial proof passes; no broad enforcement flip inside the build.
- Full suite green before merge and before close.

## Explicitly out of scope

- Re-running W31’s broad evidence-authority count.
- Retrying the strong single-duty omission experiment.
- ACT-343 or other standing debt unless it blocks this exact liveness proof.
- General multi-machine redesign.

Those remain visible future work. Combining them here would repeat W31’s scope failure and violate the 80/20 standard.

## Reports and approval boundary

Observer 1 reports at real milestones and at three hours if still open, with the liveness verdict leading. A registry label never counts as progress. Opening requires: verbatim start reaffirmation, this exact approved charter copied from proposal to charter, workers named, run registered, liveness predicates initially green, lifecycle beyond `pre_start_gate`, and canonical plan moved to W32 with read-back proof.
