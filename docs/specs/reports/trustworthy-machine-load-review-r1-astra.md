# Review round 1 — GPT-6 Astra (codex CLI), 2026-10-25

1. **Verdict: not ready.**

The diagnosis justifies the work, but the spec understates changes to routing, assumes a rebalance integration that does not exist, and promises a resource guarantee its mechanisms cannot enforce.

2. **Factual errors and omissions versus code**

- **D2’s “existing `RebalancePlanner` → `TransferOrchestrator` path” is not wired.** The planner explicitly documents that it is dormant and omits channel scope, which could move Slack work onto an incompatible machine (`src/core/RebalancePlanner.ts:89`). Missing session counts are not the only reason rebalance cannot fire.
- **A1/§7 are not merely reporting changes.** Current `online` uses local receipt age (`src/core/MachinePoolRegistry.ts:345`), including repeatedly rerecorded git heartbeats potentially approaching an hour old (`src/commands/server.ts:20845`). Changing it to direct-only liveness changes placement eligibility (`src/core/PlacementExecutor.ts:164`).
- **A3 overstates `ws44PoolCache`.** It is a gated, request-driven cache keyed by peer and route, not an autonomous poller collecting every peer’s `/pool` observations (`src/server/PoolPollCache.ts:155`; `src/commands/server.ts:21125`).
- **B1 conflates available memory with native pressure.** `hostMemoryPressure` computes availability from `vm_stat` or `/proc/meminfo`; it does not supply macOS warning/critical status or Linux PSI. On failure it substitutes server RSS, potentially making an overloaded host look healthy (`src/monitoring/hostMemoryPressure.ts:87`, `:109`).
- **Heartbeat plumbing needs explicit expansion.** `PeerPresencePuller` enumerates forwarded fields; adding a local report alone will not transmit it (`src/core/PeerPresencePuller.ts:287`). Sparse coarse beats also replace observations, dropping load fields (`src/core/MachinePoolRegistry.ts:284`, `:299`).
- **“That is a starved server” is unsupported certainty.** Timeouts and resets establish impaired reachability, not its cause; C4 itself identifies port forwarding as an alternative.

3. **Ranked design flaws and concrete fixes**

1. **Evidence freshness can be manufactured.** “Newest wins” lacks clock-skew handling, original observation identity, and protection against peers circulating the same evidence. Liveness also mixes successful observations with failed attempts. **Fix:** keep direct success, latest failure, and relayed historical evidence separately. Preserve origin, boot/report sequence, original age, and receipt time; never refresh sample age when rereading cache or disk. Define state precedence and retain existing operational `online` semantics during the reporting rollout.

2. **The reserved floor is not a resource reservation.** One session slot and `nice +5` cannot protect memory, disk, a blocked Node event loop, or Windows host resources. Operator sessions can consume the warden’s slot; multiple resident agents can each reserve against the same host. **Fix:** describe v1 as best-effort headroom; enforce atomic host-wide admission with one exclusive recovery slot, handle limits of zero/one explicitly, and bound helper/test consumption. Keep sampling asynchronous and cached—the existing memory sampler can synchronously block for five seconds.

3. **The verdict rules contradict each other and can miss emergencies.** B1 requires two families; C2 declares memory pressure alone saturated. A fully blocked server cannot publish three reports, while sleep/resume can produce a late heartbeat without overload. **Fix:** define a decision table: sustained critical memory or severe loop impairment independently closes admission; corroboration handles ambiguous CPU/load signals. Specify sample windows, expiry, wake grace, and missing-data behavior. Separate admission closure from permission to transfer.

4. **Automatic movement lacks an executable safety contract.** Planner activation needs channel compatibility, consent wiring, target headroom reservations, one coordinator, and bounded failure recovery. The orchestrator enters `transferring` before flush/send and has no local rollback on those failures (`src/core/TransferOrchestrator.ts:115`, `:125`). **Fix:** specify deadlines and epoch-safe recovery for every stage; serialize/reserve incoming capacity; demonstrate source resource release. Check the twice-per-hour breaker *before* another move. Test concurrent planners, unreachable sources, failed targets, restart, and consent denial through production wiring.

5. **Unknown-load exclusion can strand the entire fleet.** Mixed versions, boot warmup, or missing platform metrics could make every machine ineligible. **Fix:** distinguish absent optional measurements from absent trustworthy admission evidence; define bounded queues, deduplicated escalation, operator recovery access, and staged mixed-version rollout.

6. **V1 is oversized.** Footprint reconciliation, model adjudication, peer evidence aggregation, and a warden introduce several control loops simultaneously. **Fix:** first ship honest evidence, a minimal sampled report, and deterministic admission. Add movement after failure tests; keep intelligent assessment asynchronous and advisory.

4. **Answers to section 8**

1. **Priority is insufficient.** Defer a separate responder for best-effort v1; it improves event-loop isolation but cannot guarantee host resources or a recovery session.
2. **The thresholds are hypotheses, not validated boundaries.** Use single-signal emergency overrides, corroboration for ambiguous signals, and calibrate in shadow mode.
3. **Peer evidence should remain display-only in v1.** Require fresh direct target contact and admission confirmation before placement.
4. **Defer the warden as an automatic dependency.** Deterministic admission must work without it. Later, run one bounded advisory assessment per episode when headroom exists.
