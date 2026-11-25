# Side-Effects Review — Work Board approval record binding checkpoint

**Version / slug:** work-board-approval-binding-wip
**Date:** 2026-11-24
**Author:** Echo
**Second-pass reviewer:** independent Work Board approval reviewer

## Summary of the change

Tier 2 project checkpoint. Work Board approval records can preserve an exact generation binding. Durable journal readback reconstructs the event from the actual stored fields instead of depending on a caller's remembered request. The enabled production writer and slip routes are still absent.

## Decision-point inventory

- Work Board replicated schema — add validation of a present approval binding for an approval put whose recomputed generation matches the record ID.
- Journal receipt evidence — use the exact validated fields to recover the approval proof, version and winning source.

## 1. Over-block

Existing records omit the new binding and keep the existing schema behavior. A new record with a malformed binding or mismatched stable ID fails schema validation. A malformed row cannot provide an exact winner or a proof of absence.

## 2. Under-block

The schema establishes shape and binding consistency, not authorized authorship. The enrolled production writer must be proved at append and projection, and its durable event must match the authoritative decision source.

## 3. Level-of-abstraction fit

The store schema owns record validation. The journal readback owns durable evidence. The policy and exact owner-device proof belong to the production writer and slip authority.

## 4. Signal vs authority compliance

[Signal vs Authority](../../docs/signal-vs-authority.md). The deterministic schema authenticates no person. It preserves exact fields for the existing owner-authorized production boundary to evaluate.

## 4b. Judgment-point check

No new static heuristic for a competing-signals judgment. Record type, typed version and deterministic generation are enumerable.

## 5. Interactions

- **Shadowing:** legacy approvals do not contain the optional field.
- **Double-fire:** recovering a present binding returns the exact deterministic record identity and does not emit or acknowledge a new event.
- **Races:** the enrolled writer is still responsible for the reservation and current-proof check.
- **Feedback loops:** the codec adds no pickup or journal emission.

## 6. External surfaces

No client or approval route change in this checkpoint. Future receipt generation requires a production writer that emits the bound record.

## Verification

Focused unit tests include a mismatched-generation regression. The real Work Board journal fixture emits an approval binding and reconstructs it from durable validated journal data.

## Independent second pass

The reviewer concurred with checkpointing after confirming the binding survives real durable readback and that boot rebuild and live projection both exclude bound records or the reserved event namespace. The receiver must prove the enrolled writer, and the applied tap must match its exact owner proof and material version, before enabling the projection path.

## Outer tap binding

The generation now includes the material and title hashes used by the existing Work Board tap. The decoder compares both with the durable outer record and refuses a mismatch. Legacy events still omit the optional binding, and writer-bound events still cannot reach the legacy fold. Regression tests cover changing either outer field while preserving the recorded binding.

## Owner and proof binding

The generation now includes the enrolled owner’s person key. The decoder requires the same person on the outer tap, with PIN proof for console or bulk and presence proof for phone or slip. The independent reviewer concurred. These checks establish consistency of the durable event. The production gate still owns verification of the original authentication.

## Server card snapshot

WorkBoardService now derives a detached disclosure and exact version from cards that still await approval. The snapshot binds card and policy history, the selected disclosure, and the existing material and title hashes. It is internal and does not grant approval. The independent reviewer concurred. Production routing must apply the normal authorization and show the exact selected disclosure.

## Bound journal append

WorkBoardService can now accept an in-process, owner-authenticated exact approval when an authority adapter is supplied. It rechecks the current writer proof, owner and card version, then enqueues the bound event without applying the legacy fold or invoking its local write observer. No production caller supplies the adapter yet. The result refers to the journal decision and cannot be shown as proof of card projection. The mounted paths must wait for the enrolled writer and durable projection gates before using it.

The service reserves the event ID before enqueuing it. A timeout, missing sequence or unproved emit outcome leaves that reservation in force for the process lifetime unless exact durable readback resolves it. Recovery on restart still needs the complete enrolled journal and writer proof.

## Server presence-signing fixture

The server builds a distinct finite-slip action line using the existing owner-device presence envelope. The shared fixture checks byte-for-byte parity with the iPhone implementation and rejects noncanonical UUID or digest strings. Existing routes remain unchanged. Challenge issuance, authentication, and consumption stay with the owner-device authority when the new action is mounted.

Independent review reproduced the shared fixture digest and concurred with the dark checkpoint. The helper rejects non-string inputs before constructing the signing line.

## Durable slip decisions

The store saves one immutable ordered slip per authenticated source and records one exact decision per slip in an immediate SQLite transaction. The decision, source, proposal digest, and current writer must match. An unsigned expired slip refuses a decision. An exact committed replay returns the same record. Digest, canonical shape, and source identity are verified on read, and persistent database handles require a durable journal mode. Routes must authenticate source and owner proof before calling the store and must verify the currently enrolled writer and sealed history before applying the recorded decision. The store checkpoint has no live call site. Tests cover integrity, expiry, source deduplication, decision replay, and reopening a persistent database.

Independent review concurred after sealing the exact slip ID and expiry together with the canonical proposal. Tests cover malformed and changed stored deadlines and a real database reopen. The production authority must distinguish committed receipt recovery from fresh application.

## Per-card application claims and results

Recording the signed decision and inserting its pending item rows occur in the same SQLite transaction. The enrolled application adapter must claim each exact item before invoking the writer. A claim cannot be taken again, including after a reopen. An incomplete claim appears unresolved. A completion must match the recorded claim, and a winning event must match that exact signed card generation. Results are returned in the signed order. The caller still owns current enrollment, verified presence, and journal proof for every asserted winner. This store has no production caller.

Independent review concurred with the per-card state transitions. The 24-hour deadline also bounds new claims. Exact completion of an already claimed item can still record its durable receipt after expiry. Production claims require fresh enrolled writer proof from the adapter.

## Apply a signed slip

The internal application adapter reads the signed decision, claims items in order and supplies the exact stored version to the approval writer. It checks the enrolled writer before each claim and after each asynchronous result. It accepts an applied or independent winner only when the proof and version match the signed item and the production projection adapter confirms the exact event. An uncertain result remains claimed and is never retried blindly. The adapter has no production caller.

The loop snapshots the decision and writer proof on entry and preserves the validated winning event ID across asynchronous observation. Projection confirmation is read-only. Regressions exercise a caller changing its decision during application and a winner generated for a different version.
