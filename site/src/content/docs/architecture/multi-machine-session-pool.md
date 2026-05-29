---
title: Multi-Machine Session Pool
description: How one agent identity runs across several machines at once — placing, transferring, and load-balancing conversations between them while staying exactly-once.
---

When you run the same agent on more than one machine — a laptop and a Mac mini, say — Instar can treat them as a single **pool of compute** rather than a primary with a cold standby. Every machine is awake; each conversation is *placed* on the best-fit machine; and you can move a live conversation from one machine to another mid-stream just by naming it ("move this to the mini"). The conversation continues coherently on the new machine, and no message is ever dropped or doubled.

This page maps the layers that make that work. The whole subsystem ships **dark** (off until you explicitly enable it through a staged rollout), and a single-machine agent behaves exactly as it does today.

## The layers

### L0 — Machine-to-machine backbone (`MeshRpc`)

Machines talk over a thin, signed request/response layer. `MeshRpc` carries a small command set (`place`, `claim`, `release`, `transfer`, `deliverMessage`, `capacity-report`, `secret-share`) inside an envelope that is Ed25519-signed, bound to a specific recipient, and protected against replay by a nonce + timestamp. The receive side (`MeshRpcDispatcher`) runs a five-step verification — recipient, signature, registered-peer, unseen-nonce, fresh-timestamp — and a per-command authorization gate *before* any handler runs; a rejected command never even burns its nonce. The send side, `MeshRpcClient`, builds and signs the envelope, POSTs it to a peer's `/mesh/rpc`, and surfaces the typed result. Together `MeshRpcClient` and the dispatcher are the secure transport every other layer rides on.

### L1 — Router lease

Exactly one machine holds the **router** role at a time, decided by a fenced lease (the same monotonic-self-fence discipline the cross-machine lease already uses). The router is the single writer of placement decisions in steady state; if it goes silent, another machine re-elects and resumes.

### L2 — Machine pool registry (`MachinePoolRegistry`, `NicknameAssigner`)

The `MachinePoolRegistry` tracks every machine's live capacity — load average, active session count, memory pressure, capabilities, hardware — plus a clock-skew quarantine state machine that pulls a machine with a bad clock out of placement. Each machine gets a friendly, editable nickname (auto-assigned by `NicknameAssigner`, deduplicated against the pool) so you never have to type a raw machine id. The registry and `NicknameAssigner` together back the dashboard's **Machines** tab and the nickname you use in a transfer command.

### L3 — Per-session ownership (`SessionOwnership`, `SessionOwnershipRegistry`)

Ownership of a conversation is movable and fenced by a `(status, epoch)` pair. `SessionOwnership` is the pure state machine — `place → claim → transfer → release`, with the epoch arithmetic and legal sequencing enforced in one place. `SessionOwnershipRegistry` sits on top and performs the compare-and-set: a single-ref fast-forward push decides the winner when two machines contend, never a `machineId` comparison. The exactly-one-owner invariant is structural — a worker runs a session only while it observes itself as the `active` owner at the current epoch, and the `SessionOwnershipRegistry` rejects a stale or replayed claim.

### L4 — Placement + routing (`PlacementExecutor`, `NicknameCommand`, `SessionRouter`, `DeliverMessageHandler`)

`PlacementExecutor` is the single, canonical placement brain. Its policy is structured data (weights, thresholds, ordering), validated against a fixed schema at startup, so every machine in a pool makes consistent decisions. `PlacementExecutor.decide()` is pure and ordered — hard-constraint, then pin, then sticky, then least-loaded — and on an unsatisfiable hard pin or capability it *queues and escalates* rather than silently mis-placing.

For each inbound message the `SessionRouter` resolves ownership and dispatches: handle locally if it owns the session, forward over `MeshRpc` to the owner otherwise, re-place on owner death, or — for a brand-new conversation — call `PlacementExecutor`, claim ownership synchronously, and spawn. The owner side runs `DeliverMessageHandler`, which records each forwarded message in the processing ledger *before* acting on it; a redelivered message is ACKed as a duplicate and never re-processed, so a handoff can't double-reply. The `SessionRouter` dispatches strictly in order per session and advances the platform offset only after `DeliverMessageHandler` confirms durable receipt.

When you say "move this to the mini" or "run this on the workstation", the `NicknameCommand` recognizer parses that — conservatively, only on an explicit relocation verb plus a known nickname, so a passing mention of a machine never triggers a move. `NicknameCommand` resolves the nickname against the registry; an unknown name is rejected with the valid options rather than mis-routed.

### L5 — Transfer / handoff (`TransferByNickname`, `TransferOrchestrator`)

`TransferByNickname` turns a recognized relocation request into a gated plan: it resolves the target, enforces a per-topic rate limit, no-ops if you're already there, and requires confirmation when the target is offline or you're mid-reply. `TransferByNickname` is the planner; `TransferOrchestrator` executes the move. `TransferOrchestrator` drives the ordered handoff — `active(source) → transferring → active(target) → source-release` — which is claim-before-release: because the fence is the status+epoch (not the physical release), there is never a double-run and never a no-owner gap. It bounds the drain of an in-flight reply, enforces an output-exclusion window so the two machines' output never interleaves, and verifies the ledger snapshot is fully settled before the target resumes — if the synced state is incomplete, `TransferOrchestrator` escalates honestly instead of resuming from corrupted context.

### L6 — Multiple agents per machine (`MachineLoadBroker`)

When several agents share one machine, each agent's router must see the *true* machine load, not just its own. `MachineLoadBroker` accounts for every resident agent's sessions and — crucially — does not trust agent self-reports for the authoritative number: it cross-checks each agent's claimed footprint against the OS-measured footprint. An agent that reports itself idle while actually saturating the box is flagged `suspect-overloaded`, so a lying agent can never attract sessions onto an already-busy machine. `MachineLoadBroker` also verifies the isolation invariant — distinct ports, identities, and non-nested home directories.

## Rollout and rebalance (`StageAdvancer`, `SessionPoolE2EResultStore`, `RebalancePlanner`)

The pool activates through a graduated ladder: **dark** (code shipped, always-local) → **shadow** (real placement + ownership, no moves) → **live-transfer** (failover + explicit pins) → **rebalance** (load-driven moves). The ladder is enforced in code, not by willpower. `SessionPoolE2EResultStore` is a signed, append-only record of each stage's end-to-end test outcome; `StageAdvancer` is the *sole* writer of the rollout stage and refuses to advance a stage unless the prior stage's result is green for the current commit — and `StageAdvancer` mechanically reverts if a live stage later regresses. A direct config write to the stage is rejected; only `StageAdvancer` holds the capability to change it.

Once at the rebalance stage, `RebalancePlanner` proposes bounded moves off an over-saturated machine — only non-pinned, low-priority sessions that are off their transfer cool-down, at most one move per source per cycle so it can never cascade. `RebalancePlanner` is evaluated only on the heartbeat interval, never per message, so a single message can't trigger a storm of transfers.

## What it reuses

The pool doesn't reinvent the cross-machine primitives Instar already had. The router lease builds on `LeaseCoordinator` and the existing `MultiMachineCoordinator`; peer authenticity reuses `MachineIdentity` (Ed25519 signing + the registered-peer set); the exactly-once guarantee leans on the same `MessageProcessingLedger` that direct ingress uses; and a transferred session resumes through the existing `TopicResumeMap`. `MachineIdentity` and `MessageProcessingLedger` in particular are load-bearing here — the first is what makes a `MeshRpc` envelope verifiable, the second is what makes a `DeliverMessageHandler` redelivery a no-op. Reusing `LeaseCoordinator`, `MultiMachineCoordinator`, and `TopicResumeMap` keeps the pool consistent with the single-machine behavior you already rely on.

## Guarantees

- **Exactly-once on channel messages and replies** — never dropped, never doubled — across placement, transfer, and failover. (External tool side effects are best-effort-once; carry your own idempotency key for those.)
- **Backward compatible** — a one-machine agent is byte-identical to today, and the whole pool stays dark until you advance the rollout stage.
- **Observable** — `GET /pool` shows the router, every machine's nickname/hardware/load/clock state; `GET /session-pool/e2e-results` shows the rollout gate's state.
