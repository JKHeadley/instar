# Stuck session input health classification

Tier 1. One runtime rule changes. The first commit attempt identified the missing review trace.

- Over-block. The existing Needs You filter excludes this single recovery warning. Health still reports the incident.
- Under-block. Other Health rules keep their own classifications.
- Layer. The exact Health rule supplies the metadata to the existing Needs You projection.
- Signal and authority. The rule supplies action metadata. The projection makes the visibility decision under the existing policy in accordance with docs/signal-vs-authority.md.
- Interactions. The warning keeps its existing health severity. Message recovery, delivery records, and session ownership checks use the same paths.
- External surfaces. Health responses include the action marker. Needs You excludes the item for readers on that version.
- Multi-machine posture. Each machine classifies its own Health records using its installed version. The rule adds no synchronization, transport, or durable state.
- Rollback. Revert the rule to restore its previous presentation.
