# Convergence Report — Feedback Factory Operating Drain

## Cross-model review: codex-cli:gpt-5.5 + gemini-cli:gemini-3.1-pro-preview

Real GPT-5.5 and Gemini 3.1 Pro external reviews ran on the operator-amended body. Both final verdicts were MINOR ISSUES with no material blocker. A separate internal authority-model review initially found four material contract gaps and two residual inconsistencies; all six were repaired, and its final verdict was CONCUR.

## ELI10 Overview

The feedback system currently accepts and groups reports but stops before turning them into owned work. This design makes the pipeline actually finish: a registered Instar agent using a frontier model reviews bounded cluster evidence, the system creates one durable work item, and the existing Initiative view shows it to the development workflow. Human approval is reserved for ambiguity and break-glass cases rather than becoming the pipeline's throughput ceiling.

The safety tradeoff is deliberate. Classification cannot silently create work, every transition is crash-safe and bounded, and waiting work is measured rather than forgotten. The first landing also registers a reusable rule: any canonical intake pipeline must name its owner, consumer, waiting/terminal outcomes, and a real end-to-end proof.

## Original vs Converged

The first draft treated readiness, queue state, simulation, and source scanning too loosely. Review separated product status from readiness authority; reduced the queue to a closed transactional outbox; made the Initiative task the single user-visible handoff; added exact lease/token fencing; replaced full JSONL rescans with a crash-safe generation protocol; added an independent due-review index; constrained simulation to an isolated exact state machine; defined local-disk failover, backup/RPO/RTO, security, performance, and recurring reconciliation; and narrowed the structural lint so it cannot pretend to prove runtime liveness. After the operator rejected a human-default readiness bottleneck, iteration 10 replaced it with an operator-rooted, registered frontier-model agent authority inside deterministic floors, with human escalation only for ambiguity, integrity repair, and explicit intervention.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|---|---|---:|---|
| 1 | internal integration/security/scalability | 12 | separated readiness, chose SQLite authority, defined real consumer and bounds |
| 2 | internal reviewers | 7 | closed states, promotion authority, cursor truth, corruption posture, discovery guard |
| 3 | internal | 0 | internal convergence |
| 4–7 | Codex + internal | 10 | source generation/compaction, due index, self-heal fields, backup and restore |
| 8 | Codex + internal | 7 | gated implementation sequence, narrow lint, throughput SLO, recurring reconciliation |
| 9 | internal + Gemini | 0 | final internal convergence; Gemini CLEAN |
| 10 | authority-focused internal + GPT-5.5 + Gemini 3.1 Pro | 6 material, then 0 | agent-first readiness authority; closed operator-rooted registry; no model hold authority; no-PIN normal-path and negative fixtures; registry backup; saga/real-adapter clarity |

## Full Findings Catalog

- **State/authority — material:** legacy cluster status could conflict with queue lifecycle. Resolved with separate closed readiness state and work-derived claim/completion.
- **Durability/concurrency — material:** JSONL work and machine-local fallback could duplicate or strand work. Resolved with a local SQLite transactional outbox, unique epoch key, fenced lease/token, one operated host, and no fallback writer.
- **Consumer truth — material:** an internal task row could masquerade as handoff. Resolved with one readable `InitiativeTracker` task keyed by immutable `feedbackWorkKey` and authoritative read-back before completion.
- **Rollout authority — material:** config or simulation could bypass consumer promotion. Resolved with PIN-bound proposal-set promotion and isolated simulation that cannot satisfy production acceptance.
- **Readiness throughput authority — operator amendment/material:** human-only readiness would merely move the bottleneck onto operator attention. Resolved with a registered frontier-model Instar agent as the normal authority within deterministic floors and a human-only escalation/break-glass path.
- **Authority root — material:** “registered agent” was not a security boundary without a registration principal. Resolved with a closed immutable-versioned operator-rooted authority registry, generation/audit chain, rejection of self-registration and stale/revoked/mismatched identities, and backup/restore coverage.
- **Hold boundary — material:** model output could impose or clear an integrity disposition. Resolved by removing `held` from the model schema, reserving imposition to deterministic integrity or human break-glass, and requiring deterministic revalidation before agent-requested release.
- **Amendment evidence — material:** the first acceptance list proved only a happy path. Resolved with no-PIN default-path, authority rejection, proposal/canary/injection/spend demotion, restoration, and hold-boundary fixtures.
- **Incremental discovery — material:** an ingest-sequence cursor could not discover unprojected JSONL appends or survive compaction. Resolved with generation/offset/checksum sidecar, transactional cursor advance, replay, and checksummed compaction handoff.
- **Governed waiting — material:** collecting clusters could never be revisited. Resolved with a separate `(nextReviewAt, clusterId)` due index, fairness caps, lag metrics, and a 24-hour initial SLO.
- **Recovery — material:** backup manifests omitted source bytes. Resolved with one versioned set containing generations, manifests, DB/WAL, cursors, promotion posture, and linkage plus bare-host restore proof.
- **Structural confidence — material:** lint was assigned semantic runtime authority. Resolved by limiting lint to typed coverage/ownership/handoff/CI citations and assigning cadence/idempotency/progress to constructed smoke/E2E.
- **Operational proportionality — external minor:** final Codex review still preferred smaller releases. The operator requested one merged end-to-end PR, so the spec uses three separately tested internal commits but blocks merge until the full safe vertical slice is green.
- **External minor — proportionality/LLM choice:** both external families asked whether deterministic policy would be simpler. The operator explicitly required frontier-model agent judgment as the class default; the final text now explains the competing semantic signals that prevent a brittle score from holding readiness authority, while keeping deterministic rules as the floor and exact transition authority.
- **External minor — clarity/saga:** resolved with a plain-language lifecycle, a named outbox/saga invariant for cross-store recovery, and a rule that a mocked terminal consumer cannot satisfy the real-operation positive control.

## Convergence verdict

Re-converged at iteration 10 after the operator's agent-first authority amendment. No material findings remain; the focused internal reviewer returned CONCUR, and real GPT-5.5 and Gemini 3.1 Pro reviews returned only non-blocking proportionality/clarity suggestions. The operator explicitly approved the spec with this amendment, so it is ready for the approved build.
