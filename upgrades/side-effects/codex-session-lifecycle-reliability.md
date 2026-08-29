# Side-Effects Review — Codex session lifecycle reliability

**Version / slug:** `codex-session-lifecycle-reliability`
**Date:** `2026-08-28`
**Author:** `Echo`
**Second-pass reviewer:** `Helmholtz (independent_side_effects_review)`

## Summary of the change

This change makes inbound Codex delivery crash-safe and makes watchdog recovery attribution truthful. It adds a durable SQLite delivery-effect journal (`InboundDeliveryStore`), a kernel-backed physical-effect lock and single dispatcher, recipient-encrypted ownership-transfer custody, a restart-durable scoped recovery authority, executable/vnode process provenance, an authenticated status route, and migration/agent-awareness updates. The decision points are delivery admission, transfer custody, ambiguous-effect recovery, watchdog eligibility, rollout activation, and recovery actuation.

## Decision-point inventory

- `SessionManager` inbound delivery admission — modify — fail closed if the durable journal cannot prepare the delivery.
- `InboundDeliveryStore` boot reconciliation — add — classify unfinished attempts as ambiguous without replaying their body.
- `SessionDrainRunner` custody handoff — modify — source fencing and target durable encrypted import must complete before close/claim.
- `SessionWatchdog` candidate eligibility — modify — protect suspected hosts conservatively; confirmation requires realpath, vnode, start-time, and direct parent agreement.
- `RecoveryActuationAuthority` — add — restart-durable, deterministic, dark-by-default authority for one scoped recovery action at a time.
- `/sessions/inbound-delivery-status` — add — authenticated, read-only machine-local observability.

## 1. Over-block

If SQLite is unavailable, a legitimate inbound message is refused instead of being injected without durability. This is intentional fail-closed behavior: the caller receives a failure and the message remains recoverable upstream, avoiding an unprovable duplicate effect. Exact executable matching protects only `codex-code-mode-host`; similarly named user commands remain eligible for watchdog review.

The first live candidate exposed an additional scope boundary: non-Codex and legacy unknown-framework job injections were entering the Stage-B ledger even though only Codex has a generation-bound acceptance observer. Those rows could never advance and would age into false unknowns. The canonical `rawInject` boundary now journals only a positively identified `codex-cli` session; known non-Codex and unknown frameworks retain their established injection path until they gain an equivalent observer. Semantic tests exercise both bypass sides through public `sendInput`, while the production E2E proves the Codex side still journals and advances.

## 2. Under-block

The journal cannot prove whether a process consumed bytes after a crash in the final side-effect window, so it reports `effect-unknown` and refuses blind replay. Consumption is instead established only from the pinned Codex rollout adapter's generation-bound user-turn evidence; composer clearing remains weaker evidence. A renamed, unmeasurable, or conflicting Codex framework executable is `ownership-unknown` and preserved; it is never falsely called confirmed.

## 3. Level-of-abstraction fit

Persistence and attempt transitions live at the transport/session boundary where the side effect occurs. The watchdog remains a detector for process/liveness evidence; it does not gain new recovery authority. Recovery actuation is centralized in a separate authority with deterministic scope and a dark default, rather than letting each detector act independently.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the watchdog produces signals consumed by a separate authority.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The journal's fail-closed checks are transport invariants and idempotency mechanics, explicitly exempted from judgment classification. The exact host exclusion is typed framework attribution, not a semantic guess. Recovery decisions are owned by the scoped authority and are audit-visible.

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals judgment point. Journal state transitions are enumerable transport invariants; executable attribution is exact; and the recovery authority's floors and deterministic scope are declared in the driving spec.

## 5. Interactions

- **Shadowing:** durable preparation occurs before tmux injection, so journal failure intentionally prevents the existing injection path.
- **Double-fire:** a delivery id has one durable state machine; ambiguous attempts are never body-replayed. Kernel flock plus durable phases serialize physical effects, and recovery capabilities are single-use across restart.
- **Races:** SQLite FULL durability, transactions, kernel ownership, action-time owner/epoch fences, and transfer CAS preconditions serialize concurrent delivery updates. Watchdog descendant discovery is read-only and rechecked against incarnation-bound provenance.
- **Feedback loops:** journal/status observations do not themselves trigger injection. The authority is dark by default and bounded when enabled.

## 6. External surfaces

Agents gain an authenticated read-only status endpoint and more accurate watchdog outcomes. Persistent state is a per-agent SQLite journal containing HMAC-derived identifiers rather than plaintext message bodies. Telegram and other adapters do not change wire formats. Timing remains dependent on process state, but ambiguous effect is now surfaced honestly. No new operator action is required; therefore no phone-only workflow is introduced.

## 6b. Operator-surface quality

No dashboard or operator action surface is changed — not applicable.

## 7. Multi-machine posture

**Machine-local effects, transferable custody:** tmux processes, watchdog descendants, and whether bytes may have reached a local Codex host are machine-specific truths. During topic transfer the source first enters `transferring`, atomically fences its live rows, encrypts replay material to the target machine's X25519 key, and sends it over the signed recipient-bound mesh RPC. The target validates authenticated source/target/conversation/epochs and durably imports before the source may close or land the target claim. A refused carrier aborts transfer and restores source custody at the newer epoch. Ambiguous effects remain terminal source evidence and are never exported as replayable work.

## 8. Rollback cost

Recovery actuation can be darkened immediately, but a raw binary rollback is fenced while live delivery evidence or its 24-hour tombstones exist. Every delivery mutation projects a non-replayable ID tombstone into the legacy pending-inject surface and refreshes a downgrade-floor marker; `UpdateChecker.rollback()` refuses below that floor. A forward hotfix or a fully drained tombstone window is the supported rollback path. Schema evidence is never deleted to make rollback appear safe.

## Conclusion

The independent reviews found material spec-to-code gaps and correctly blocked the first release candidate. The revision closes them with package-bound signed activation evidence, rollout identity/offset/turn correlation, live-row transfer preservation, crash-safe effect fencing, and exact-cap scanner handling. The first live candidate then correctly invalidated its own evidence window after exposing observerless non-Codex rows. Helmholtz independently cleared the scope-boundary repair after semantic public-`sendInput` coverage proved both known non-Codex and unknown frameworks leave the ledger unchanged, while the production E2E proves Codex still journals and advances (18/18 focused). **Code clearance is granted.** Publication remains mechanically conditional on a refreshed repository gate and a fresh signed two-hour/fifty-delivery Stage-B release-candidate window required by the driving specification.

## Second-pass review (if required)

**Reviewer:** Helmholtz (`independent_side_effects_review`)
**Independent read of the artifact:** concur

Helmholtz granted final code clearance after independently checking the shared and legacy rollout scanners' exact-cap behavior, including no-final-newline, partial-tail, and exact-newline cases, and running the focused suite successfully (49/49). No code blocker remained. The reviewer explicitly kept the signed Stage-B canary artifact as a separate release gate.

After the first live candidate exposed observerless non-Codex rows, Helmholtz
withheld clearance until both known non-Codex and unknown-framework injections
were covered semantically through the production `sendInput` path. The revised
tests use a real manager and SQLite store, stub only the external framework/tmux
seams, and prove both paths inject without adding a delivery row. Together with
the positive Codex production E2E, the refreshed focused gate passed 18/18 and
Helmholtz granted clearance with no remaining blocker.

## Evidence pointers

- `docs/specs/reports/codex-session-lifecycle-reliability-convergence.md`
- `tests/unit/InboundDeliveryStore.test.ts`
- `tests/unit/RecoveryActuationAuthority.test.ts`
- `tests/integration/codex-inbound-effect-journal.test.ts`
- `tests/integration/physical-effect-lock-provider.test.ts`
- `tests/unit/FrameworkProcessProvenance.test.ts`
- `tests/unit/SessionDrainRunner.test.ts`
- `tests/e2e/codex-session-lifecycle-reliability.test.ts`

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: n/a`, `reason: RecoveryActuationAuthority is a caller-invoked one-shot authority whose capability is single-use and delivery-scoped; Stage C actuation remains dark. The periodic Stage-B observer records evidence and bounded notices but cannot restart, replay, respawn, or otherwise actuate recovery.`
