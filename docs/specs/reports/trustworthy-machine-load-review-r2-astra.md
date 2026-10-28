# Review round 2 — GPT-6 Astra, 2026-10-25

**Verdict: not ready.** P1 is substantially improved, but admission and movement still need explicit safety contracts.

**Round-1 points**  
Shared findings are consolidated below.

- **Dormant planner / missing channel scope — partially resolved.** D1 acknowledges both, but the live `OwnershipReconciler` processes pins and performs ownership CAS directly; its production wiring does not invoke `TransferOrchestrator`. D4 therefore hardens a different execution path. Specify how overload proposals enter reconciliation and which actual path enforces reservations, deadlines, consent, rollback and source cleanup.
- **Changing `online` changes routing — resolved for P1.** Existing operational semantics are explicitly preserved.
- **`ws44PoolCache` mischaracterization — resolved.** Sightings now use `PeerPresencePuller`.
- **Peer hardware provenance — resolved.** Reports explicitly carry hardware independently of registry sync.
- **Heartbeat allowlist and coarse-beat data loss — resolved in the design.**
- **Native pressure versus availability; RSS fallback — resolved in the design.**
- **Synchronous memory sampling — resolved.** Sampling becomes asynchronous and cached.
- **Timeouts prove starvation — resolved.** The incident now distinguishes reachability evidence from suspected cause.
- **`MachineLoadBroker` scope — resolved by removal.**
- **Evidence freshness — partially resolved.** Separate slots and non-relay rules help, but A4 still compares observer-clock timestamps without a skew/age protocol. B1 also permits repeatedly transmitting a cached load report without defining sample expiry. Require original sample identity, age propagation and expiry; fresh transport contact must not renew stale load evidence.
- **Resource reservation — partially resolved.** Best-effort wording and operator-only recovery access are improvements. However, locking the recovery slot alone does not make ordinary admission atomic across resident agents. Define the shared capacity accounting, concurrent admission rule, and `maxSessions=0` behavior; otherwise ordinary work can consume the supposed headroom.
- **Verdict contradictions / emergency handling — partially resolved.** Single-resource overrides and wake grace are added. Specify whether three samples means all three must qualify, and ensure a known critical signal wins when another measurement is missing; otherwise `unknown` can mask an emergency.
- **Movement safety — partially resolved.** Reservations and deadlines are named, but D4’s blanket timeout rollback is unsafe after target claim. Recovery must inspect the current fenced ownership state: before claim, abort conditionally; after claim, retain target ownership and retry source cleanup. Explicitly verify resource release.
- **Unknown-load fleet deadlock — partially resolved.** Ranking addresses mixed versions; the fallback introduces the blocker below.
- **Oversized v1 / warden / model adjudication — resolved.** Phasing, deterministic self-help and advisory-only P4 are appropriate.

**New blocking issue**

**C5 defeats both overload admission and existing placement constraints.** When every machine refuses work, it unconditionally places on the router—even if that router advertises `acceptingWork:false`. Either this bypasses C1 and worsens overload, or local admission queues it anyway, so C5’s promised escape does not work. “It answers the message” also does not establish the required capabilities or satisfy a hard pin; `PlacementExecutor` currently queues those unsatisfied constraints.

Limit fallback to machines satisfying hard constraints and local admission. If none qualify, preserve the payload in a bounded queue, acknowledge/escalate through the lightweight control path, and allow only explicitly authorized recovery work through the reserved slot.
