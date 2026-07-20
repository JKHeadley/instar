# Side-Effects Review — Feedback Factory Operating Drain

**Version / slug:** `feedback-factory-operating-drain`
**Date:** `2026-07-20`
**Author:** `Instar-codey`
**Second-pass reviewer:** required — durable queue, model authority, PIN mutations, multi-process fencing, and canonical-pipeline guard
**Status:** Concurred after correction-pass re-review. The independent reviewer initially withheld concurrence across ownership, source-generation, isolation, scrubbing, authority-failure, API, performance, cancellation, and restore/failover boundaries. Each finding received a concrete fix and positive/negative control; the final re-review concurred.

## Summary and decision points

This change registers Canonical Pipeline Operational Completeness and its structural/runtime evidence guards, then completes the Feedback Factory path from canonical report storage through bounded clustering, registered frontier-model readiness, a fenced SQLite outbox, and exact-key Initiative handoff. Development processing/drain defaults live; the consumer remains simulation-only until a durable PIN-approved promotion. Fleet defaults remain dark.

Decision points added or changed:

- Canonical-pipeline declaration coverage: deterministic structural signal; CI can reject missing declarations/citations, not semantic product decisions.
- Feedback readiness: a registered frontier-model Instar agent is the default bounded authority. Deterministic evidence, identity, generation, model/provider, prompt/schema, confidence, spend, and injection floors constrain it. Human authority is escalation/break-glass only.
- Consumer promotion, authority mutation, and break-glass hold: PIN-rooted operator authority with mutation intent and same-origin checks. A registered agent may release only after the named deterministic source/projection/authority predicate passes.
- Queue claim/ack: deterministic SQLite lease/token/owner-epoch authority.
- Generated-default drift is visible through posture and startup diagnostics but is not automatically repaired in this landing. Runtime recovery is deferred to the separately converged reusable SelfHealGate/P19 foundation lane; this PR contains no feature-local retry engine.

## 1. Over-block

- A valid agent readiness batch is refused if its registered provider/model family or prompt/schema canary differs from the resolved runtime. This is intentional fail-closed behavior; the cluster remains collecting rather than disappearing.
- A legitimate retry with a reused request nonce is rejected. The scheduled job creates a new bounded nonce each invocation; a rejected replay does not mutate state.
- A non-holder machine cannot admit local work; each mutating/ack stage is re-fenced against the live lease epoch, and request replay protection is durable across restart. The correction pass adds the authenticated one-hop owner proxy and exercises its refusal/replay path before concurrence.
- Corrupt, truncated, or generation-drifted source projection holds progress. It does not guess an offset or manufacture readiness.

## 2. Under-block

- Metadata-only readiness can still approve work whose underlying product interpretation later proves wrong. Completion means only that a readable Initiative handoff exists; it never closes the legacy cluster or claims the product fix is complete.
- The title-level injection detector is a deterministic floor, not a complete semantic detector. The frontier model is also instructed to treat all packet fields as untrusted; output is constrained and cannot emit `held`.
- Novel or obfuscated sensitive content outside the deterministic credential-pattern floor could still reach bounded metadata. Raw report bodies remain excluded entirely, and known credential shapes are scrubbed before queue persistence.

## 3. Level-of-abstraction fit

- Pipeline completeness lives in one typed intake registry plus one manifest, not scattered comments.
- Runtime evidence is separate from structural lint: constructed consumer, enabled cadence, effective idempotency, progress, and real read-back have their own verifier/E2E.
- SQLite owns cross-store queue truth, leases, authority generations, audit, source cursor/checksums, and artifact links. InitiativeTracker owns the user-visible artifact. The boundary is an idempotent saga, not a fake distributed transaction.
- The existing FeedbackProcessingService and InitiativeTracker are extended instead of replaced.

## 4. Signal vs authority compliance

Compliant with `docs/signal-vs-authority.md`.

- Structural and runtime pipeline guards produce deterministic evidence about construction/completeness; they do not decide product readiness.
- The readiness judgment is explicitly routed to a registered frontier-model authority with provenance and deterministic floors.
- The model cannot hold or clear a hold by judgment. Corruption/integrity logic and the PIN-rooted human break-glass surface own hold; a registered agent can release only when the named deterministic revalidation predicate independently passes.
- Consumer promotion remains an operator decision, separate from agent readiness approval.

## 5. Interactions and feedback loops

- Concurrent ticks collapse onto one durable active run; concurrent OS processes converge through SQLite uniqueness and busy fencing.
- Repeated readiness/enqueue/consume uses exact keys, so cadence retries do not multiply work or Initiatives.
- A crash after Initiative creation re-reads by `feedbackWorkKey` and completes the same work; it never recreates the artifact.
- Simulation clones a bounded queue snapshot into a separate ephemeral SQLite database and exercises the real claim/link/ack FSM there; canonical attempts, leases, retry times, dead letters, bytes, and artifacts remain untouched.
- Source compaction is serialized with all append writers, fsyncs the next immutable generation and checksummed handoff manifest, retains the old generation, and requires the durable SQLite tail cursor to acknowledge the exact boundary before following it. Before/after append, projection/cursor transaction, and manifest publication crash points replay without duplicate projection.
- Spend, batch, attempt, lease, due-review, source-projection, reconciliation, and full-tick work are bounded. No self-triggering loop schedules another tick.
- Cancellation is durable and owner-fenced, is observed only at explicit stage boundaries, and intentionally abandons the run without entering the self-heal loop. Terminal history pruning is owner-fenced, capped at 500 rows per tick, and preserves immutable idempotency tombstones.
- Production source compaction is stage-budgeted on a durable 24-hour cadence. The first observation establishes the baseline instead of compacting a large historical source at startup; empty generations are not rotated.
- The feedback job is enabled on development agents and treats an unexpected dev 503 as degradation, preventing silent “healthy” darkness.

## 6. External and operator surfaces

- New authenticated status/tick, run-cancellation, bounded backlog-analysis, failover-finalization, authority, promotion/revoke, and break-glass hold/release routes.
- Normal readiness ticks require Bearer auth, registered `X-Instar-AgentId`, mutation intent, and a one-use bounded nonce; no PIN or human readiness mutation is required.
- Operator mutations require PIN, `X-Instar-Request`, same-origin when an Origin is present, and the existing durable PIN-attempt brake.
- Responses expose bounded identifiers/counts/state only; raw report bodies, prompts, transcripts, credentials, and claim tokens are absent.
- Historical backlog analysis is metadata-only, registered-agent/nonce bound, capped by the authority batch limit (and an absolute 100-row ceiling), and cannot classify or dispatch work.
- The standing operator surface remains the phone-capable dashboard/API control plane. Primary actions are promotion/revocation and break-glass repair; destructive state deletion is not exposed. No raw filesystem paths or internal stack traces are returned. Phone-width behavior inherits the existing dashboard/API controls; no new desktop-only flow is introduced.

## 7. Multi-machine posture

**Cluster-shared, canonical-holder writes with authenticated one-hop forwarding.** The mutating routes are registered `cluster-shared` in `WriteDomainRegistry`; the canonical host owns the local SQLite DB, source cursor, authority generation, promotion record, and Initiative handoff. Peer machines do not self-elect or run competing drains. Live lease epochs fence admission, stage heartbeats, claims, retries, and artifact acknowledgement. Backup recursively includes the operated feedback directory. PIN-rooted failover finalization verifies the successor epoch, restores/increments the durable owner epoch, reconciles Initiative links by immutable `feedbackWorkKey`, and forces a checkpointed failover backup before cadence resumes. The destructive restore fixture removes the entire operated state directory and rejects stale claims after restoration.

A destructively restored snapshot boots in `restorePending`: canonical ownership, ticks/proxying, backup cadence, nonce admission, cancellation, authority/readiness mutations, and consumer promotion/revocation remain fenced until checksum-bound PIN finalization succeeds. Routine same-file checkpoint restart remains live. The restore fixture proves pre-finalization database, promotion, run/work, and Initiative invariance and post-finalization successor activation.

## 6b. Operator-surface quality

The dashboard addition is a read-only Feedback Drain status tab; it adds no operator mutation or destructive action.

1. **Leads with the primary action:** yes. The tab opens directly on the current drain posture, followed by backlog, progress, and source-integrity summaries; no explanatory toggle hides the status.
2. **Zero raw internals as primary content:** yes. The primary content uses plain state labels and bounded counts/ages. It does not render JSON, hashes, fingerprints, UUIDs, file paths, or claim tokens.
3. **Destructive actions de-emphasized:** yes. There are no destructive or mutating actions in this surface.
4. **Plain language + phone width:** yes. The tab reuses the existing responsive Process Health card layout, vertically stacks its three short sections, uses normal dashboard tap targets, and introduces no table, fixed width, horizontal scroll, or truncated identifier column.

## 8. Rollback cost

- Immediate rollback: disable `feedbackFactory.drain.enabled`; processing can remain independently available. Disable/revoke the consumer promotion to return to simulation without deleting queue state.
- Revoke the authority generation to stop readiness decisions while preserving every audit row.
- Reverting code leaves additive SQLite tables and optional Initiative fields readable/ignorable; no destructive migration is required.
- Fleet is dark by default, bounding blast radius to development agents until an explicit future promotion.

## Verification evidence

- Repository-wide delivery ratchets classify the dashboard tab on the glance floor, account for the process-lifetime SQLite handle, declare cancellation and failover as cluster-shared writes, preserve the keyword-intent baseline, and keep the no-silent-fallback baseline unchanged.
- Structural guard negative fixtures: missing intake/stage/owner/handoff/cadence/metrics/citation/CI collection.
- Runtime guard negative fixtures: unconstructed consumer, disabled cadence, ineffective idempotency, missing progress, fake wiring.
- Unit/integration: authority generations/restore/spend/demotion/canaries, proposal-set nonce binding, token fencing, stale owner epochs, exact idempotency, isolated simulation, crash-after-artifact recovery, source append/projection/handoff crash recovery, generated-default/posture visibility, cancellation boundaries, retention tombstones, backlog analysis, write-domain census, and destructive restore/failover finalization.
- E2E: canonical feedback intake records are projected and clustered by the real processing service, then traverse real AgentServer + SQLite + InitiativeTracker with no PIN on normal agent readiness.
- Multi-process/machine: two real OS processes create exactly one work/link pair; two conflicting approval writers create one approval plus an integrity hold; concurrent append+compaction loses no accepted source row. A separate network fixture uses two state trees, two SQLite/Initiative stores, asymmetric Ed25519 identities, real HTTP/fetch, and real services to prove only the registry owner executes and stale epoch/owner envelopes cannot mutate either side.
- Performance: one real drain tick over a 150,000-row source under concurrent ingest projects/processes 500, performs readiness/enqueue/live bounded consumption, proves the oldest pre-existing eligible row is claimed first within one tick, stays under 90 seconds and 512 MiB, and exposes remaining lag.
- CI correction: the destructive-restore fixture copies the exact checkpoint-authenticated SQLite bytes before close, and restored-file identity includes birth time as well as device/inode because Linux may immediately recycle a deleted inode. This preserves the production checksum/identity guard while distinguishing a real replacement from routine reopen. The operated-drain initialization fallback is explicitly annotated because it logs, exposes unavailable posture, and raises an urgent item for integrity failures. The exact push-config shard-4 invocation passes the destructive-restore case.

## Second-pass review

Independent correction-pass review: **CONCUR**. The final review inspected the shared restore-pending gate, destructive restore invariance, checksum/identity-bound finalization, routine restart distinction, stale-owner fencing, and in-flight cancellation linkage, and ran the focused high-risk fixtures green.

## Class-Closure Declaration

No feedback-drain self-action controller ships in this landing. Runtime recovery is owned by the separately tracked shared SelfHealGate/P19 foundation lane, so this feature does not claim an unbounded-self-action closure.
