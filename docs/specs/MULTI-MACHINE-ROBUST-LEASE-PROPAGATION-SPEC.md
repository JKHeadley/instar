---
title: "Multi-Machine Robust Lease Propagation — active PULL, LAN-optional, rollout-driven"
slug: multi-machine-robust-lease-propagation
status: approved
approved: true
approver: justin
approved-at: 2026-06-01T22:33:00Z
approval-mode: approved-with-change
review-convergence: 2026-06-01T21:41:16Z
review-iterations: 2
author: echo
created: 2026-06-01
companion-eli16: MULTI-MACHINE-ROBUST-LEASE-PROPAGATION-SPEC.eli16.md
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
related-principles: "Framework-Agnostic — and Framework-Optimizing (engines-agnostic is the sibling of machines-coherent); the founding goal of coherence; Structure beats Willpower; A Wall Is a Hypothesis"
constitutional-fit: >
  Indisputable: this spec's lease-correctness half (one coherent agent across machines,
  no split-brain) IS the founding case of the "Cross-Machine Coherence — One Agent,
  Robust Under Degraded Conditions" article, which was added to the constitution
  specifically to home this work — the operator chose this (option (b), 2026-06-01)
  over stretching Framework-Agnostic. The LAN-optional half is that article's "LAN is
  an Optimization, Never a Dependency" operational sub-standard.
approval-as-data-note: >
  approved-WITH-CHANGE: the operator chose option (b) — add a dedicated
  Cross-Machine Coherence constitutional article — over my default (a) (accept
  Framework-Agnostic via the sub-standard). Divergence category: missing-principle
  (the work's fit to existing standards was weak; the constitution grew to cover it).
  This is the bidirectional Constitutional-Traceability fork resolving toward "improve
  the constitution."
lessons-engaged:
  - P1   # Structure > Willpower — lease fencing + rollout gating are structural, not willpower
  - P3   # Migration Parity — new GET /api/lease route + config defaults reach existing agents
  - P4   # Testing Integrity — partition/split-brain E2E is the missing tier-3; all three tiers
  - P10  # Comprehensive-First — fix propagation + wire rollout + add the regression test, no deferral
  - P11  # A Wall Is a Hypothesis — "can't prove multi-machine live" was a wall; the inventory found the real gaps
lessons-declined:
  - P2   # Signal vs Authority — lease decisions are epoch-CAS (deterministic by design, the FencedLease authority model); noted, not an LLM-authority case
spec-class: multi-machine-lease   # NEVER auto-approval-eligible (safety-class per the governance spec)
approval-note: >
  APPROVED 2026-06-01 (operator chose option (b) — see approval-as-data-note).
  Authored under the 2026-06-01 directive (topic 13481): "build multi-machine the
  robust, long-term-appropriate way; LAN-optional but it MUST work for machines that
  are NOT on a LAN." Sibling to the autonomous-operation governance spec; this is the
  first real spec authored to comply with that spec's Part C (Constitutional
  Traceability) — the gate caught an over-claimed "indisputable" parent fit on first
  use, surfaced the fork, and the operator resolved it by adding the Cross-Machine
  Coherence article (option (b)). The Constitutional-Traceability gate worked.
  build+test only; NO production stage/lease activation.
---

# Multi-Machine Robust Lease Propagation — active PULL, LAN-optional, rollout-driven

## Problem

A live multi-machine proof (move a conversation to another machine and have it
reply) has been impossible to demonstrate, and drilling to the root surfaced four
structural gaps — none of them load, tunnels, or stale code:

1. **Lease propagation is PUSH-only / PULL-blind.** `HttpLeaseTransport` (the fast,
   over-tunnel lease overlay) has exactly four methods — `broadcast(lease)` (push our
   signed lease to peers' `POST /api/lease`), `observed()` (return what peers pushed
   to us), `isReachable()` (true iff *our own* last broadcast succeeded), and
   `recordObserved(lease)` (the receive path). There is **no active pull**: a standby
   only learns the holder's lease state if the holder *pushes* to it. Over the
   internet with asymmetric latency or a holder that goes quiet, a standby cannot
   *ask* "what is the current lease?" — it can only wait. This is the core
   robustness gap: the system works when every machine can push to every other, and
   degrades to "wait for git sync or timeout" otherwise.

2. **The rollout driver is discarded.** `StageAdvancer` — the sole writer of
   `multiMachine.sessionPool.stage` (dark → shadow → live-transfer → rebalance) — is
   instantiated and immediately thrown away at `src/commands/server.ts ~9651 (the `void new stageMod.StageAdvancer` discard)`
   (`void new stageMod.StageAdvancer({...})`, with the in-code comment "Held for the
   rollout job/route to drive"). Nothing calls `advanceTo()` / `reconcile()`, so the
   pool is pinned `dark` in production regardless of E2E results.

3. **The commit SHA is `'unknown'` in production.** `StageAdvancer`'s
   `currentCommitSha` resolves `process.env.INSTAR_COMMIT_SHA ?? process.env.GITHUB_SHA ?? 'unknown'`.
   Outside CI those env vars are unset, so E2E results (which `StageAdvancer` gates
   stage advances on, *per current commit*) never match — the gate can never pass.

4. **There is no partition / split-brain regression test.** The two-machine E2E
   harness (`tests/e2e/multi-machine-e2e.test.ts`) exercises pairing, signing,
   heartbeat-promotion — but never a network partition where both machines believe
   they hold the lease, then heal. The exact failure mode the lease design exists to
   prevent is untested.

Justin's framing (2026-06-01): build this **robust even in poor conditions** —
loaded machines, network issues — and **LAN-optional but it MUST work for machines
that are NOT on a LAN.** LAN is a fast-path overlay; the cross-internet path is the
spec.

## Goals

1. **Active PULL** lease propagation that works peer-to-peer over the internet
   (tunnel URLs), so a standby can *ask* for the holder's current lease rather than
   only waiting to be pushed to. LAN-optional: it uses whatever reachable URL a peer
   advertises (LAN address if co-located, tunnel URL otherwise) — never LAN-only.
2. **Wire `StageAdvancer`** so a rollout tick **reconciles** (auto-reverts toward
   `dark` on a red/stale E2E) on cadence, and **enables** operator-gated advancement
   (green-E2E-for-the-current-commit validated) — advancement itself stays a manual
   operator step, so the pool never auto-advances.
3. **Fix `currentCommitSha()`** to resolve the actual commit (env → `SafeGitExecutor`
   `git rev-parse HEAD`, boot-cached → `'unknown'`), so the E2E↔commit match works
   outside CI.
4. **Add the partition/split-brain regression E2E** (partition → both acquire →
   assert split-brain; heal → assert epoch-CAS converges to exactly one holder),
   exercising the real `LeaseCoordinator` (not the heartbeat-only harness).
5. **Propose a new operational sub-standard — "LAN is an Optimization, Never a
   Dependency"** — under the Framework-Agnostic article (agent proposes, operator
   ratifies — not yet canonical).

## Non-Goals

- No production stage activation. This spec is build+test only; the pool stays
  `dark`, no lease config is flipped, no session is moved in production. Activation
  is a separate, operator-gated step after the E2E proves green.
- No change to the FencedLease epoch-CAS authority model (it is correct by design;
  this spec makes peers *see* each other's epochs faster, it does not change how the
  winner is decided).
- The git-backed `GitLeaseStore` durable path is unchanged; this hardens the *fast*
  HTTP overlay so it no longer depends on synchronous pushes.

## Design

### Part A — "LAN is an Optimization, Never a Dependency" (operational standard)

An operational sub-standard under the **Cross-Machine Coherence — One Agent, Robust
Under Degraded Conditions** article (a tactical application of its internet-first /
degrade-cleanly rule, not a new constitutional article — per the registry's "Two
layers"). The parent article names this sub-standard explicitly:

> **Rule.** Any cross-machine path must function over the public internet (via the
> peer's advertised tunnel URL). A LAN address is an opportunistic fast-path overlay
> that MUST degrade cleanly to the internet path; no coordination correctness may
> depend on co-location. **Parent:** *Cross-Machine Coherence — One Agent, Robust
> Under Degraded Conditions*
> (the floor: "every code path must be able to fall back; options a path can't honor
> degrade to advisory hints, never hard failures").
>
> **In practice.** Peer reachability is resolved from the registry's advertised URL
> (tunnel URL when machines are apart, LAN address when co-located). A LAN-only
> assumption anywhere in the lease/mesh/transfer path is a defect. Tests must cover
> the internet-only topology, not just a shared-filesystem simulation.

### Part B — Active PULL lease propagation (the core robustness fix)

Symmetric to the existing push (`POST /api/lease` → `recordObserved`):

- **New `GET /api/lease`** (machineRoutes, behind the same `machineAuthMiddleware` as
  `POST /api/lease` — NOT the Bearer `authMiddleware`): returns the responder's
  **effective-view** lease (or null) — which on a standby may name a *third* machine
  as holder (the holder's lease, re-served). The puller validates it via
  `FencedLease.acceptTunnelLease` (signature against the **named holder's** registered
  key + epoch-floor + nonce), so a re-served third-party lease still validates. It MUST
  NOT apply the POST holder==responder guard (`POST /api/lease` 403s a pushed lease
  whose `holder` ≠ sender) — applying that to GET would let a standby pull only from
  the actual holder, defeating "ask any peer."
- **New `HttpLeaseTransport.pullPeer(peerUrl): Promise<LeaseRecord | null>`** — GETs
  `${peerUrl}/api/lease`, validates the signed lease, and feeds it through the same
  `recordObserved(lease)` path the push receiver uses (so the effective-view fold is
  unchanged — this only adds a *second way* for a peer lease to arrive).
- **New `HttpLeaseTransport.pullAllPeers(peerUrls): Promise<void>`** — best-effort
  fan-out pull; failures are advisory (a peer being unreachable is data, not an
  error), consistent with `broadcast()`'s tolerant return.
- **Standby pull cadence (`supervision`: Tier 0 — a deterministic epoch fold, no
  policy/LLM decision):** the `MultiMachineCoordinator`'s standby path calls
  `pullAllPeers()` on a bounded, **jittered** interval (config
  `multiMachine.leasePullIntervalMs`, default ~5s, floored; ± jitter so
  booted-together standbys don't pull in lockstep). It pulls the current holder each
  tick + all peers on a slower sweep. The cadence is **constant regardless of holder
  liveness** — it does NOT speed up when the holder goes quiet (failover is bounded by
  epoch-CAS, not by pull frequency), so a dead holder cannot trigger a pull-storm. Peer
  URLs come from the registry's advertised URL (tunnel-first; LAN if co-located) —
  Part A. A standby that *discovers* a split-brain via pull routes it to the
  logs/dashboard (Near-Silent-Notifications), never the user's chat.
- **Reachability becomes bidirectional:** `isReachable()` today is "our last
  broadcast succeeded." Add an observed-side signal so reachability also reflects a
  *successful pull* — a standby behind a one-way NAT (can pull, can't be pushed to)
  is now correctly seen as connected.

This is the LAN-optional robustness fix: pulls use the same internet-facing tunnel
URLs the mesh already uses, so it works for machines that are not on a LAN; when a
LAN address is advertised it is simply a faster route to the same endpoint.

### Part C — Wire the rollout driver

- **Drive `StageAdvancer`:** replace the discarded `void new StageAdvancer(...)` at
  `server.ts ~9651 (the `void new stageMod.StageAdvancer` discard)` with a retained instance driven by a rollout tick. The tick calls
  **`reconcile()` only** — `StageAdvancer.reconcile` REVERTS toward `dark` on a
  red/stale E2E (or no-ops at `dark`); it never advances. **Advancement** toward
  `shadow`/`live` is OPERATOR-TRIGGERED only: an explicit route/action calling
  `advanceTo(next)`, gated on a green E2E for the current commit. So the driver can
  only ever move toward safe (`dark`) — it **ships dark and never auto-advances**;
  promoting the pool is always a deliberate operator step (a `multi-machine-lease`
  safety-class decision, never auto, per the governance spec).
- **Fix `currentCommitSha()`:** resolution chain `process.env.INSTAR_COMMIT_SHA ??
  process.env.GITHUB_SHA ?? SafeGitExecutor.run(['rev-parse','HEAD'])` (boot-cached;
  `rev-parse` is already allowlisted in `SafeGitExecutor`, precedent
  `featureRolloutScan.ts`) `?? 'unknown'` (non-repo → `'unknown'`). Routing through
  `SafeGitExecutor` rather than a bare `git` shell-out honors L12 Destructive-Tool
  Containment. The cache is boot-scoped, safe under the restart-on-update model. Now
  the E2E↔commit match works in dev/local, not only CI.

### Part D — Partition / split-brain regression E2E

⚠️ The existing `tests/e2e/multi-machine-e2e.test.ts` harness (`createMachine` +
dual-`MultiMachineCoordinator`-over-`sharedDir`) exercises **`HeartbeatManager`
role-promotion only** — it never instantiates `FencedLease`/`LeaseCoordinator`/
`HttpLeaseTransport`, and `holdsLease()` falls back to `_role === 'awake'` until
`attachLeaseCoordinator()` is called. So "epoch-CAS converges to one holder" CANNOT
be observed on that harness. This test MUST therefore **explicitly stand up a
`LeaseCoordinator` (with `FencedLease` + an `HttpLeaseTransport`) per machine and
`attachLeaseCoordinator()` it** — it tests the lease layer, not the heartbeat layer.

1. **Partition:** stand up two machines, each with its own attached
   `LeaseCoordinator`; sever propagation between them (separate transports / drop the
   push+pull channel) so neither sees the other's lease writes → both acquire →
   **assert the split-brain condition** via `getSyncStatus()` (`awakeMachineCount ===
   2`, both `holdsLease() === true`, `splitBrainState` set).
2. **Heal:** re-link the transports (push+pull) → **assert `FencedLease` epoch-CAS
   converges to exactly one holder** (`getSyncStatus().awakeMachineCount === 1`, the
   higher-epoch holder wins, `splitBrainState` clears).
3. **Internet-topology variant (Part A):** the heal path is driven by the new
   `pullPeer` over a **mock HTTP transport** (not a shared filesystem), proving
   convergence works over the internet-style path, not only via the git/fs substrate.

## Testing (Testing Integrity Standard — all three tiers)

- **Unit:** `pullPeer` validates a signed peer lease and rejects an unsigned/garbage
  one (both sides); `pullAllPeers` is failure-tolerant (one unreachable peer does not
  fail the batch); `isReachable` reflects a successful pull; `currentCommitSha`
  resolution chain (env set → env; unset in a repo → rev-parse; unset non-repo →
  `'unknown'`).
- **Integration:** `GET /api/lease` returns the signed current lease over the HTTP
  pipeline and a peer's `pullPeer` accepts it; `StageAdvancer` reconcile advances on a
  green-E2E row for the current commit and reverts on red.
- **E2E (feature-alive + the new regression):** the partition→heal split-brain test
  (Part D) — the headline missing tier-3; plus `GET /api/lease` returns 200 on the
  production init path.
- **Wiring integrity:** the `StageAdvancer` instance is retained and its driver
  actually calls `reconcile()` (not `void`-discarded); `pullPeer` feeds the real
  `recordObserved`/`effectiveView` fold; `GET /api/lease` is registered.

## Migration Parity (P3)

- `GET /api/lease` ships in code (reaches existing agents on the normal update).
- `multiMachine.leasePullIntervalMs` default added via `migrateConfig()` with an
  existence check.
- The rollout driver is additive and dark-by-default; no existing agent's stage
  changes (it stays `dark` until a real green E2E + operator gating).
- Agent Awareness (P5): note the active-pull behavior + `GET /api/lease` in the
  multi-machine section of the CLAUDE.md template — BOTH halves: `generateClaudeMd()`
  (new agents) AND a `migrateClaudeMd()` content-sniff guard (existing agents), per
  the Migration Parity Standard.

## Side-Effects Review (canonical L6 — seven dimensions)

1. **Over-block risk.** N/A to a gate; the risk analogue is over-eager stage
   advancement — mitigated by keeping advancement dark + green-E2E-gated + operator-
   gated past shadow.
2. **Under-block risk.** A standby could still miss a holder change if BOTH push and
   pull fail (total partition) — that is the genuine partition case, correctly handled
   by epoch-CAS convergence on heal (Part D), not papered over.
3. **Level-of-abstraction fit.** PULL is added at the transport layer (symmetric to
   the existing push), not bolted onto the coordinator — the right seam.
4. **Signal vs Authority (P2).** Lease decisions stay epoch-CAS (the FencedLease
   authority model — deterministic by design); pull only changes *when* a peer epoch
   is *seen*, never *who wins*. No new authority introduced.
5. **External surfaces.** Adds `GET /api/lease` (auth-gated, read-only, returns a
   signed lease — no secrets); outbound pulls go only to registry-advertised peer
   URLs (same trust domain as the existing push/mesh). No new third-party calls.
6. **Interactions with existing primitives.** Pull feeds the SAME `recordObserved`
   /`effectiveView` fold as push (no divergent path); `GET /api/lease` mirrors the
   existing `POST /api/lease`; `StageAdvancer` is the existing component, now driven;
   git `GitLeaseStore` durable path unchanged. No new split-brain surface — pull can
   only *accelerate* convergence.
7. **Rollback cost.** All additive + dark/default-off. Disable pull = set
   `leasePullIntervalMs` to 0 (falls back to today's push-only behavior). The rollout
   driver reverts to `void`-equivalent by leaving the stage `dark`. `GET /api/lease`
   is read-only and harmless if unused.

## Open questions for ratification (proposals I proceed under unless redirected)

1. **Pull cadence** — default `leasePullIntervalMs ≈ 5000` (5s), floored to avoid
   hammering; only standbys pull, only when a holder exists.
2. **Pull targets** — a standby pulls the *current lease holder* every tick + all
   peers on a slower sweep (holder freshness matters most). Proceeding with this.
3. **Stage activation stays manual** — this spec wires the driver and proves green
   E2E, but advancing the production pool past `dark`/`shadow` remains an explicit
   operator action (and is a `multi-machine-lease` safety-class decision per the
   governance spec — never auto-approved).
4. **Parent-principle fit (Constitutional Traceability fork) — RESOLVED 2026-06-01:
   operator chose (b).** The conformance review judged the fit to *Framework-Agnostic*
   a rule-level match but reasonably *weak* rather than indisputable (that article's
   earned-from is engine-portability, not network transport). The fork was: (a) accept
   Framework-Agnostic via Part A's sub-standard, or (b) add a dedicated
   cross-machine-coherence article. **The operator chose (b)** — the new
   *Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions* article was
   added to the registry (Building family) and is now this spec's parent; the
   lease-correctness half is its founding case, and the LAN-optional half is its
   "LAN is an Optimization, Never a Dependency" sub-standard. This also homes the
   recurring "robust even in poor conditions" theme in the constitution.
