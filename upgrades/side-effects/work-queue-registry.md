# Side-effects review: unified work-intake registry

- Over-block: terminal work is excluded and duplicate titles are collapsed; status and source remain visible for active work.
- Under-block: v1 ranking is deterministic and advisory; no LLM authority or automatic actuation is introduced.
- Level of abstraction: adapters supply normalized read data, while the registry owns deduplication and ranking.
- Signal vs authority: the queue is a read-only prioritization signal; it never gates dispatch or messaging.
- Interactions: the dark gate returns 503 on fleet agents and avoids changing existing source stores.
- External surfaces: dev-agent-only GET/POST routes expose ranked metadata.
- Multi-machine posture: machine-local by design for v1; source adapters can later use existing replicated reads.
- Rollback: remove the optional context and routes; no migration is required.

## Class-Closure Declaration

- defect class: `unbounded-self-action`
- closure: `n/a`
- reason: read-only ranking and rescoring are not self-triggered actions.

The rescore route is explicitly non-mutating and the capability index exposes the agent-facing prefix.

### Increment 2 — live adapters and route wiring (2026-07-24)

- Commitment items read through `CommitmentTracker.getActive()`.
- Evolution items read through `EvolutionManager.listActions()`.
- Feedback items read through `FeedbackProcessingService.activeClusters()` and its canonical JSONL store.
- Topic items read through `ParallelActivityIndex.activities()` over `TopicIntentStore` state.
- The registry is attached to the constructed `AgentServer` route context before the server reference is published.
- Live proof snapshot from this install: the same adapter set produced `status: 200` semantics and 24 active items (14 evolution actions, 10 topic activities), with ranked items beginning `ACT-001` “Check Codey Mini Serve Proof 2 session” and `ACT-002` “Check Codey Mini Serve Proof session”.

### Docs-coverage follow-up (2026-07-24)
Docs page + doc comments for the work-queue routes and registry class (docs-coverage ratchet compliance; no behavior change). Ceremony completed by Echo over Codey's prepared work after turn-boundary stalls.
