# Side-Effects Review — Journal job-claim readiness floor

**Version / slug:** `job-claim-cutover-readiness`
**Date:** 2026-10-28
**Author:** Echo
**Second-pass reviewer:** supervision side-effects reviewer

## Summary of the change

The runtime keeps WS4.3 journal job claiming on the existing AgentBus path until peer claim receive and a pool-wide atomic claim authority exist. `JobLeaseClaimStore` exposes a code-owned readiness constant set to false. `server.ts` applies it to both the scheduler cutover input and heartbeat capability advert. `JobScheduler` remembers the mechanism actually acquired per fire, so completion and script attempt IDs cannot consult a stale local lease when the bus path was used. Config, registry, and manifest descriptions are corrected; unit, integration, and lifecycle tests assert the gate. The decision point is claim-path selection before a scheduled job starts. This is a safety prerequisite for the approved job-result supervision v2 multi-machine rollout, which explicitly holds active routing until route-generation claims are supported by every executor.

## Decision-point inventory

- `server.ts` scheduler journal-cutover input — modified: an enabled feature flag cannot select local-only journal leasing while the pool authority is absent.
- `server.ts` heartbeat WS4.3 capability advert — modified: the machine cannot advertise journal-lease support while that authority is absent.
- `JobLeaseCutoverGate` — passed through: its existing pure flag-coherence decision remains unchanged.
- `JobClaimManager` legacy bus claim — passed through: it remains the selected path.
- `JobScheduler` claim completion and script fire ID — modified: each uses the acquired path for that fire, not whichever local record happens to exist.

## 1. Over-block

A development agent whose operator explicitly enabled WS4.3 still cannot use journal claims. That is intentional because two local lease stores can both grant the same slug. The current bus route still permits scheduled work; the floor blocks only this unproven cutover.

## 2. Under-block

The legacy bus is best effort and can still double-run in a partition or simultaneous-claim race. This change does not claim to fix that existing limitation. It also does not implement route-generation claim transfer, pool fallback reservations, or active Jev supervision. The v2 rollout gates remain closed until those dependencies are proven.

## 3. Level-of-abstraction fit

The runtime composition point selects the claim mechanism and publishes the machine's capability; both must use the same readiness fact. The local store cannot certify its own distributed safety. The existing `JobLeaseCutoverGate` still decides among coherent flags once the runtime declares the mechanism ready. No parallel claim authority is added.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md).

This is a hard invariant safety floor on a distributed write, not a heuristic about message meaning or user intent. It has blocking authority over the new claim mechanism because a local file cannot atomically decide ownership for two machines. The legitimate work path remains available through the existing bus. The floor is code-owned and can be lifted only in a reviewed change that supplies the missing peer receive and pool authority. It does not add a brittle content filter or a competing conversational judgment.

## 4b. Judgment-point check

No static heuristic at a competing-signals judgment point is added. The condition is structural and binary: there is no production peer receive caller for `JobLeaseClaimStore.applyRemote`, nor a pool-wide atomic acquisition. A positive flag or peer advert cannot substitute for either implementation.

## 5. Interactions

- **Shadowing:** The readiness floor is evaluated before `JobLeaseCutoverGate`; while false, that gate sees the flag off and chooses bus. It does not bypass role guard, script result recording, or quota admission.
- **Double-fire:** Only one claim path is selected for a job. `releaseClaim` now completes only that path; a stale local journal record is left untouched by a bus fire.
- **Races:** The heartbeat advert and scheduler both read one immutable code constant, so they cannot disagree during a process lifetime. The acquired path is remembered per live slug, so a flag flip during execution does not switch completion paths. A server restart loses that in-memory path; an unknown prior journal claim expires rather than being completed by a guess. Existing bus claim races remain as stated above.
- **Feedback loops:** Peers seeing a false advert remain on the bus. No peer signal can turn the readiness floor on.

## 6. External surfaces

Other machines receive `ws43JournalLease:false` in heartbeats. A configured development agent continues using the bus claim route. There is no new HTTP endpoint, operator action, URL, external provider call, Telegram notice, or persistent-state migration. Local lease files created by earlier versions remain on disk but are not consulted for bus-run admission, attribution, or completion while the floor is false. The release note explains the changed capability claim in plain language.

## 6b. Operator-surface quality

No operator surface is changed — not applicable.

## 7. Multi-machine posture

**Replicated behavior through the existing heartbeat capability field:** each running machine advertises false and independently applies the same code-owned floor before claim selection. No new durable state is replicated or stranded on topic transfer. The change emits no user-facing notice and generates no URL. This prevents a mixed pool from treating any machine as journal-ready prematurely; the legacy bus retains its documented partition limits.

## 8. Rollback cost

A revert plus patch release restores the former cutover selection. No data migration or agent-state repair is needed. Reverting before peer receive and pool authority exist would restore the identified double-run risk, so rollback should only be done with a replacement safety fix. Existing local lease files are left untouched.

## Conclusion

The review found a misleading earlier claim: a local epoch-fenced store was described as if journal replication already fed peers, but no production receive caller exists. The first independent pass also found that bus completions could mutate an old local lease, and script attempts could adopt its claim ID. The scheduler now binds those operations to the path it actually acquired, with a regression test. The confirming second pass concurred; full CI is still required. This does not make active Jev rollout ready.

## Second-pass review

**Reviewer:** supervision side-effects reviewer
**Independent read of the artifact:** First pass raised a concern: stale local journal claims could still be completed or used as script fire IDs on the bus path. The scheduler now tracks the acquired path and tests both completion directions. The reviewer re-read the change and concurred, with no remaining concrete concern.

## Evidence pointers

The first full verify caught a hand-maintained line-number map in `lint-dev-agent-dark-gate.test.ts` that moved by two lines when the config comment was added. The map is updated to the actual source lines. The other failed file, `outbound-advisory-routes.test.ts`, passed twice locally, including against the rebased main branch; it is being rechecked by the next exact-head run.

- `src/scheduler/JobLeaseClaimStore.ts` — `applyRemote` has no production caller.
- `tests/e2e/scheduler-journal-lease-cutover-alive.test.ts` — coherent flag still selects bus while authority readiness is false.
- `tests/unit/seamlessness-dev-gate-wiring.test.ts` — scheduler and heartbeat both use the readiness floor.
- `tests/integration/scheduler-journal-lease-cutover.test.ts` — stale local claim remains untouched by bus completion, and an unrelated bus claim remains untouched by journal completion.
- `docs/specs/job-result-supervision-v2.md` — active rollout held until claim-generation support exists.

## Class-Closure Declaration

No agent-authored-artifact defect or self-triggered controller is added — not applicable.
