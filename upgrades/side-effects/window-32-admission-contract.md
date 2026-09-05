# Side-Effects Review — Window 32 admission contract

**Version / slug:** `window-32-admission-contract`
**Date:** `2026-09-05`
**Author:** `Echo / W32 admission lane`
**Second-pass reviewer:** `/root/w32_admission/instar_dev_review`

## Summary of the change

The WindowLifecycle compiler and server routes now admit the byte-exact approved W32 charter through a source-specific duty profile. The change adds exact TENETS/charter fixtures, ordered multipart reaffirmation authority, fresh-source evidence for compiler-generated `source.*` duties, a server-owned liveness seam, and due-only recurrence materialization. The production-path E2E proves W32 can reach `active_start` without synthetic source language or caller-supplied liveness booleans.

## Decision-point inventory

- W32 profile selection — modified — `windowId=w32` selects the W32 catalog only with the approved charter hash.
- Lifecycle admission — modified — the three activation postconditions no longer create an admission circularity; all other existing admission requirements retain their prior behavior.
- Reaffirmation evidence admission — modified — an exact W32 seven-part source reconstruction may complete the one-shot without a pre-existing work commitment.
- Run-liveness evidence — added — only an enabled, non-dry-run server authority can mint or refresh W32 liveness evidence.
- Cadence instance creation — modified — instances are created only when due and never after close/expiry.

## 1. Over-block

Any editorial change to the W32 charter is rejected until a newly approved profile hash is deliberately added. This is intentional for the one approved charter identity, but it means harmless whitespace edits are not silently accepted. Multipart reaffirmation also rejects a legitimate recitation if its headers, logical order, topic, producer session, or reconstructed bytes differ from the approved source. The normal remedy is a new explicit approved source/profile, not weakening this contract.

## 2. Under-block

This slice cannot make an absent or incorrect Lane A liveness authority truthful. The optional server seam fails closed, and dry-run snapshots cannot admit, but production composition must still pass Lane A's live authority into `AgentServer`. The compiler also does not prove the later adversarial exit test; those close duties remain unresolved until their actual authorities produce receipts.

## 3. Level-of-abstraction fit

Source identity, multipart framing, uniqueness, hash equality, due-time ceilings, and authority mode are enumerable invariants, so deterministic validation is appropriate. Runtime truth remains owned by `windowRunLivenessAuthority.status()`; the lifecycle route consumes that authority rather than building a parallel executor/heartbeat detector or trusting HTTP booleans.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No brittle judgment detector holds runtime liveness authority.

The exact-hash and message-shape refusals are hard-invariant validation over an operator-approved source, one exact obligation, and an enumerable seven-part protocol. They do not infer message meaning. The only authority over executor/heartbeat/delivery/progress/lifecycle truth is Lane A's server-owned liveness state machine, which must be enabled and enforcing.

## 4b. Judgment-point check

No new static heuristic chooses among competing live signals. The profile/hash checks answer source identity; multipart checks answer byte reconstruction; recurrence checks answer clock boundaries. The competing liveness signals are already reconciled by the run-liveness authority and are only consumed here.

## 5. Interactions

- **Shadowing:** W32 profile selection occurs before ledger persistence, so a refusal leaves the existing ledger unchanged. The legacy W28/W31 catalog remains selected for other windows.
- **Double-fire:** run-liveness evidence uses deterministic payload nonces. Satisfied liveness duties are refreshed before authority re-query, preventing duplicate evidence from becoming false completion while allowing changed snapshots to replace stale evidence.
- **Races:** message evidence is re-queried from the live topic and local store by all seven IDs. Missing or changed rows fail closed. Ledger writes retain the existing atomic store path.
- **Feedback loops:** the fifth predicate depends on lifecycle admission. It is a continuous activation postcondition, not a start precondition: start admission occurs first, then Lane A can mark admitted/unexpired and activate the authoritative run state.
- **Recurrence:** downstream commitment creation must occur after a tick creates due instances; future-through-close pre-materialization is intentionally removed globally.

## 6. External surfaces

The compile/evidence/evaluate HTTP routes accept the new W32 source profile and multipart `messageIds` shape. Ledger version remains 1 with optional profile/start/ceiling/freeze fields, so older documents still load. The change sends no notices, creates no topics, calls no external service, and generates no URLs. Telegram rows are read-only evidence inputs. Exact source hashes and liveness snapshots are persisted in the existing lifecycle ledger.

## 6b. Operator-surface quality

No dashboard renderer, approval page, or operator form changes; not applicable.

## 7. Multi-machine posture

Machine-local by design: lifecycle admission is owned by the Echo observer process opening W32, and its run-liveness snapshot describes the executor/delivery state visible to that authority on that machine. Worker distribution across machines remains separately proven by named worker receipts; this change does not invent replicated liveness. The slice emits no user-facing notice, generates no URL, and adds no new topic-transfer behavior. The existing lifecycle ledger remains on the observer authority machine, so it is not duplicated by multiple machines independently.

## 8. Rollback cost

Rollback is a code revert and patch release. Optional version-1 ledger fields are ignored by old code; no schema migration is required. A W32 ledger created under the new profile should be preserved as audit evidence and recompiled only after the reverted compiler's requirements are intentionally addressed. No external messages or remote state require cleanup.

## Conclusion

The review kept W31-only semantics out of W32, moved source artifacts away from fake commitments, made liveness exclusively server-authoritative, and fixed the cadence ceiling globally. Focused tests cover exact positive sources, per-duty omissions, stale source hashes, multipart negatives, dry-run refusal, RuntimeRegistry independence, post-activation evidence refresh, and full production-path `active_start`. The remaining production integration boundary is explicit: Lane A must supply the real authority instance.

## Second-pass review

**Reviewer:** `/root/w32_admission/instar_dev_review`
**Independent read of the artifact:** concern

Concern raised during the admission-lane review: `runLivenessPayload` rejected future timestamps but accepted arbitrarily stale green snapshots. Composition resolved that risk before live use. Admission now rejects a snapshot older than the 60-second authority interval, rejects a mismatched lifecycle binding and terminal liveness states, and recomputes heartbeat age, durable-work age, lifecycle admission, and expiry from current authority data. The production E2E covers both mismatched-binding and stale-snapshot refusals before the fresh bound snapshot reaches `active_start`.

## Evidence pointers

- `tests/unit/window-lifecycle-obligation-ledger.test.ts`
- `tests/integration/window-lifecycle-ledger-store.test.ts`
- `tests/integration/window-lifecycle-native-adapter.test.ts`
- `tests/e2e/window-lifecycle-production-wiring.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered controller is added or modified; not applicable.
