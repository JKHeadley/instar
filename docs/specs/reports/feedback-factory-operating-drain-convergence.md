# Convergence Report — Feedback Factory Operating Drain

## Cross-model review: gemini-cli:gemini-3.1-pro-preview

Real GPT-5.5 and Gemini 3.1 Pro external reviews ran on the final reviewable body. Gemini's final verdict was CLEAN; Codex's final verdict was MINOR ISSUES. Earlier Gemini calls sometimes timed out, which is recorded as reachability without consistently proven health rather than hidden.

## ELI10 Overview

The feedback system currently accepts and groups reports but stops before turning them into owned work. This design makes the pipeline actually finish: a person approves which clusters are ready, the system creates one durable work item, and the existing Initiative view shows it to the development workflow.

The safety tradeoff is deliberate. Classification cannot silently create work, every transition is crash-safe and bounded, and waiting work is measured rather than forgotten. The first landing also registers a reusable rule: any canonical intake pipeline must name its owner, consumer, waiting/terminal outcomes, and a real end-to-end proof.

## Original vs Converged

The first draft treated readiness, queue state, simulation, and source scanning too loosely. Review separated product status from readiness authority; reduced the queue to a closed transactional outbox; made the Initiative task the single user-visible handoff; added exact lease/token fencing; replaced full JSONL rescans with a crash-safe generation protocol; added an independent due-review index; constrained simulation to an isolated exact state machine; defined local-disk failover, backup/RPO/RTO, security, performance, and recurring reconciliation; and narrowed the structural lint so it cannot pretend to prove runtime liveness.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|---|---|---:|---|
| 1 | internal integration/security/scalability | 12 | separated readiness, chose SQLite authority, defined real consumer and bounds |
| 2 | internal reviewers | 7 | closed states, promotion authority, cursor truth, corruption posture, discovery guard |
| 3 | internal | 0 | internal convergence |
| 4–7 | Codex + internal | 10 | source generation/compaction, due index, self-heal fields, backup and restore |
| 8 | Codex + internal | 7 | gated implementation sequence, narrow lint, throughput SLO, recurring reconciliation |
| 9 | internal + Gemini | 0 | final internal convergence; Gemini CLEAN |

## Full Findings Catalog

- **State/authority — material:** legacy cluster status could conflict with queue lifecycle. Resolved with separate closed readiness state and work-derived claim/completion.
- **Durability/concurrency — material:** JSONL work and machine-local fallback could duplicate or strand work. Resolved with a local SQLite transactional outbox, unique epoch key, fenced lease/token, one operated host, and no fallback writer.
- **Consumer truth — material:** an internal task row could masquerade as handoff. Resolved with one readable `InitiativeTracker` task keyed by immutable `feedbackWorkKey` and authoritative read-back before completion.
- **Rollout authority — material:** config or simulation could bypass promotion. Resolved with PIN-bound proposal-set promotion and isolated simulation that cannot satisfy production acceptance.
- **Incremental discovery — material:** an ingest-sequence cursor could not discover unprojected JSONL appends or survive compaction. Resolved with generation/offset/checksum sidecar, transactional cursor advance, replay, and checksummed compaction handoff.
- **Governed waiting — material:** collecting clusters could never be revisited. Resolved with a separate `(nextReviewAt, clusterId)` due index, fairness caps, lag metrics, and a 24-hour initial SLO.
- **Recovery — material:** backup manifests omitted source bytes. Resolved with one versioned set containing generations, manifests, DB/WAL, cursors, promotion posture, and linkage plus bare-host restore proof.
- **Structural confidence — material:** lint was assigned semantic runtime authority. Resolved by limiting lint to typed coverage/ownership/handoff/CI citations and assigning cadence/idempotency/progress to constructed smoke/E2E.
- **Operational proportionality — external minor:** final Codex review still preferred smaller releases. The operator requested one merged end-to-end PR, so the spec uses three separately tested internal commits but blocks merge until the full safe vertical slice is green.
- **External reviewer health — disclosure:** final Gemini review succeeded cleanly after earlier timeout rounds; this proves a real invocation but does not itself enroll or certify the door.

## Convergence verdict

Converged at iteration 9. No material findings remain in the final internal round. A real Gemini reviewer returned CLEAN and a real Codex reviewer returned only non-blocking proportionality/hardening suggestions. The spec is ready for user review and approval.
