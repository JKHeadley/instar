# Side effects: Conversations builds the write-admission layer it needs

## Summary

Tier 1, 4 source/test files plus notes, about 60 lines. One review pass, first commit attempt.

1. `resolveWriteAdmissionGate(config)` decides whether write admission is constructed: explicit setting → dev-agent gate → on when the owned Conversations graph is on (no witness, storage not disabled) → off. server.ts uses it in place of the bare dev-agent gate.
2. `GraphProjection` names an untitled conversation by its ref ("Topic N", "Slack channel"/"Slack thread", "App conversation").

Decision point: the change does not add a check with blocking authority. Write admission constructed by reason `conversations` runs in its configured mode, which defaults to dry-run (observe and log would-verdicts; the legacy guard keeps enforcing). Its own double latch keeps refusal authority off while the write-surface inventory is incomplete.

## 1. Over-block
No new blocking. In dry-run, write admission records would-verdicts only. `guardStoreWrite('conversationGraph.append')` returns refuse only in live mode, which this change never turns on.

## 2. Under-block
An agent that set `multiMachine.writeAdmission.enabled: false` keeps Conversations pending on multi-machine. That is the operator's explicit choice. The boot warning still names the missing piece.

## 3. Level-of-abstraction fit
The gate funnel sits beside `resolveDevAgentGate` and is the single place server.ts reads. The graph's fleet bundle keeps requiring a real WriteAdmission (it uses it for append fencing), so supplying the dependency is the right layer rather than loosening the graph.

## 4. Signal vs authority
Write admission in dry-run is a signal producer. No authority is added. Compliant with docs/signal-vs-authority.md.

## 5. Interactions
- `state.attachWriteAdmission` now runs on fleet agents with Conversations on. In dry-run, the StateManager keeps its legacy blanket guard (verified by the e2e lifecycle test's dry-run cases).
- The aggregate attention item fires on live refusals, and in dry-run only when the admission check itself throws (`admission-error`) 5+ times in a window. That is the alert the layer is meant to give: one deduped item per window, never per event.
- The lease-holder legacy `session-build-context` cleanup now also runs on fleet lease holders. That key is inert and self-draining, so the cleanup is harmless.
- The event-loop lag reader becomes available to the load report on those agents, which only adds a reading.

## 6. External surfaces
Fleet agents gain `logs/write-admission.jsonl` (dry-run verdict rows) and a working `GET /write-admission`. The Conversations list on multi-machine agents now opens. The visible title text changes for untitled conversations.

## 7. Multi-machine posture
This fixes a machine-dependent feature: write admission now resolves the same on every machine of an agent with Conversations on, instead of only on a machine with `developmentAgent: true`. The graph itself replicates through its existing certified bootstrap; nothing new is replicated.

## 8. Rollback cost
Revert the commit. Machines go back to the dev-agent gate and Conversations returns to pending on fleet multi-machine agents. Rollback needs no state repair, because dry-run rows are logs only. An agent can also set `multiMachine.writeAdmission.enabled: false`.

## Follow-up: Local Verify finding (2026-11-13)

`topic-ref-ratchet` failed: `untitledConversationName` rendered a bare `Topic ${id}`, which the operator rule (2026-11-02) forbids: a topic id is never shown without its name. It now returns the verified registry name through `topicNameFor` when one exists, else `TopicRef(id)` ("Topic N (name unresolved)"). Search still finds it by number. The resolver is the one wired at server boot; with none set, the honest "name unresolved" form is used. Tests: `tests/unit/conversation-graph.test.ts` (unresolved form, and the verified name when the registry has one).
