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
