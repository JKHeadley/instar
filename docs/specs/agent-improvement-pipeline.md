---
status: draft
source: "Justin, Telegram topic 130715, 2026-10-27"
workstream-topic: 131643
---

# Agent improvement from user corrections

## Origin and observed failure

Justin corrected Echo for asking him to inspect logs without a direct link, then asked for a built-in way for agents to improve both themselves and Instar from requests like that. Echo saved the local communication preference and submitted upstream feedback manually. That is useful instance handling, but it is not a reliable product pipeline.

The live correction audit for the first message says `shed` at 2026-10-27T20:33:21Z: the detector saw the signal, but load shedding discarded it before the ledger. The later meta-note reached `CorrectionLedger` and received a filled `ClassReview`, yet it created no work item. At that time the server counted 108 open review receipts against a cap of 50, while only one open class-review work artifact existed. The cap counted the wrong thing.

## Required path

1. **Capture:** An explicit user correction or improvement request becomes a durable, scrubbed signal even if the language model or machine is temporarily busy. The bounded backlog and existing privacy limits apply. A failed capture is visible in metrics or attention rather than silently treated as success.
2. **Classify:** Decide whether the signal calls for an agent-local preference or fix, a shared Instar change, both, or no action. A model may propose; it cannot silently relax policy or approve its own proposal. Record the decision with provenance.
3. **Assign:** Create one deduplicated, bounded local work item for each actionable class. For shared changes, create a linked Instar development candidate with the original user wording and a scrubbed technical diagnosis. User-requested changes should not depend on the same phrasing recurring four times.
4. **Execute and verify:** Track the local change through activation and a behavior check. Track the shared change through implementation, tests, release, and installation on existing agents. Preserve the correction-to-artifact links and surface pending, blocked, and verified states to the user.
5. **Close honestly:** An open review receipt is not a completed improvement. No step may claim completion from a proposal, a queued job, or a green test that did not exercise the production path.

## Incremental implementation

- **First repair (this branch):** Preserve load-shed corrections in the existing bounded backlog; count actual open Initiatives and Actions for the class-review artifact cap. Cover both with unit, HTTP integration, and production lifecycle tests.
- **Follow-through:** Add a bounded recovery pass for filled reviews that were held at capacity, with idempotent artifact creation and a durable reason when no action is appropriate. Avoid a fresh model call for already filled reviews.
- **Two-level routing:** Extend the class-review outcome to explicitly choose local, shared, or both scopes. Route shared candidates into the existing feedback factory only after its safety and privacy gates; keep operator ratification for standards changes. Link the local Action, shared candidate, and correction by stable IDs.
- **Rollout:** Enable the path on development agents first, measure capture and closure rates, then ship via the existing update migration path to fleet agents. Include agent awareness in the generated `CLAUDE.md` and migration for existing installations.

## Acceptance checks

- Replaying the log-check correction under load shedding leaves a scrubbed backlog row; once capacity returns, it appears on `GET /corrections` and receives a class review.
- More than 50 open review receipts with fewer than 50 open work artifacts do not suppress a new actionable work item. At the actual work cap, the new review stays visible and is reconsidered when capacity opens.
- A one-shot, operator-attributed improvement request can produce linked local and shared candidates without waiting for recurrence. Neither candidate is marked verified until the corresponding behavior and release checks pass.
- A new agent and an updated existing agent both expose and use the same pipeline; `/capabilities`, template awareness, and the migration agree.
