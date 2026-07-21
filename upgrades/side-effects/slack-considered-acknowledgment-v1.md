# Side-Effects Review — Slack considered acknowledgment v1

**Version / slug:** `slack-considered-acknowledgment-v1`  
**Date:** `2026-07-21`  
**Author:** `instar-codey`  
**Second-pass reviewer:** `instar-codey throughput-floor workstream reviewer`

## Summary of the change

`AmbientContributionGate` expands its one conservative semantic result from binary speak/silent to the closed action `speak | react | silent`. `SlackAdapter` mechanically executes `react` through its existing `addReaction` primitive with fixed `eyes`, buffers the inbound message, and returns without a conversational turn. Tests and Slack config documentation cover the new contract.

## Decision-point inventory

- `AmbientContributionGate.decideAction` — modified judgment authority — one existing context-rich provider call chooses one closed action.
- `SlackAdapter._handleMessage` ambient branch — modified invariant executor — exhaustive mechanical execution without content reinterpretation.

## 1. Over-block

Strict parsing can turn otherwise understandable but nonconforming provider output into silence. This is intentional: unsolicited activity must never arise from guessed or malformed output.

## 2. Under-block

A confident but socially mistaken `react` can still add `eyes`. Exposure is bounded to explicitly opted channels and the existing shared cap; no deterministic parser can guarantee recipients' interpretation.

## 3. Level-of-abstraction fit

Correct layer. The existing context-rich LLM gate retains semantic authority. The adapter reuses the existing low-level reaction primitive and performs no semantic classification.

## 4. Signal vs authority compliance

- [x] Yes — the modified authority is the existing smart gate with conversational context.

No brittle detector gains authority. Strict schema and confidence checks are deterministic safety floors around the one judgment result.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals point. The spec declares the bounded action space, conservative silent floor, existing LLM arbiter, and fallback ladder.

## 5. Interactions

- **Shadowing:** authorization, directedness, channel opt-in, inbound deduplication, and rate exhaustion still precede the model call.
- **Double-fire:** one returned action enters one branch; react returns before downstream message dispatch.
- **Races:** no new state. Speak and react consume the same existing machine-local timestamp budget immediately before execution.
- **Feedback loops:** none; no outcome feedback or retry is added.

## 6. External surfaces

Slack may receive one `reactions.add` call for the original message. The reaction is fixed to `eyes`; failures remain contained by the existing fire-and-forget primitive. No new API, dashboard, operator action, durable state, or timing controller is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Unified behavior through existing ownership.** The existing Slack owner handles the inbound event and makes the sole decision. No new state is replicated or stranded. There are no notices, durable records, or generated URLs. The unchanged legacy rate window remains local to the active owner.

## 8. Rollback cost

Pure code rollback: revert the enum/parser and adapter branch and ship a patch. There is no migration or state repair. Users would temporarily return to binary speak-or-silent behavior.

## Conclusion

The change is tightly bounded and fail-to-silent. The principal risks—social ambiguity, malformed model output, duplicate action, and reaction spam—are constrained by opt-in, fixed meaning, strict parsing, single branching, and the existing shared cap. The independent review's one documentation concern was corrected; the change is clear to ship.

## Second-pass review

**Reviewer:** instar-codey throughput-floor workstream reviewer  
**Independent read of the artifact:** concur

The reviewer verified no authority, state, retry, or analytics creep. It raised one material documentation mismatch: the adapter's legacy comment still claimed the gate could only make the agent quieter. The comment was corrected to describe the closed three-action execution, fixed reaction attempt, and fail-to-silent posture; the reviewer re-read the hunk and concurred with no remaining concern.

## Evidence pointers

- `tests/unit/slack-ambient-contribution-gate.test.ts`
- `tests/unit/slack-ambient-gate-wiring.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.
