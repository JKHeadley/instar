---
title: Multi-Machine
description: Run your agent across multiple computers with encrypted sync.
---

Run your agent across multiple computers -- laptop at the office, desktop at home -- with encrypted sync and automatic failover.

## Cryptographic Machine Identity

Each machine gets:
- **Ed25519 signing keys** -- for authentication and commit signing
- **X25519 encryption keys** -- for encrypted state sync

## Secure Pairing

Word-based pairing codes (WORD-WORD-NNNN) with ECDH key exchange and SAS verification. 3 attempts, 2-minute expiry.

```bash
# On machine A
instar pair                 # Generates a pairing code

# On machine B
instar join <url>           # Joins the mesh (--code <code>)
```

## Encrypted Sync

Agent state synchronized via git with commit signing. Secrets encrypted with AES-256-GCM at rest, forward secrecy on the wire.

## Automatic Failover

Distributed heartbeat coordination with split-brain detection. If the primary machine goes offline, the standby takes over.

## Write Authority

Primary-machine-writes-only enforcement prevents conflicts. Secondary machines queue changes until they can sync.

```bash
instar whoami               # Show this machine's identity
instar machines             # List all paired machines
instar wakeup               # Transfer awake role to this machine
instar leave                # Remove this machine from the mesh
```

Note: `whoami`, `pair`, `join`, `wakeup`, and `leave` are top-level commands, not subcommands of `machines`.

## Seamlessness Architecture (Components)

The seamlessness guarantees above -- "one agent, many machines, never two
captains, never a dropped reply" -- are split across a small set of cooperating
components. They are intentionally narrow so each one can be tested and reasoned
about on its own:

### Coordination — "who's awake right now"

- **`FencedLease`** -- the single coordination primitive: "exactly one holder,
  safe under clock skew and partition." Every other component reads its current
  epoch from here.
- **`LeaseCoordinator`** -- drives the lease over both durable (git) and fast
  (HTTP/tunnel) wire paths and owns the lifecycle of acquisition, renewal, and
  fencing.
- **`GitLeaseStore`** -- the durable, git-backed store for the lease. Survives
  process death and reboots; the slow but trustworthy source.
- **`HttpLeaseTransport`** -- the low-latency authoritative copy of the lease
  that travels over the encrypted machine-to-machine tunnel, so the standby
  sees an awake-machine demotion within seconds rather than minutes. On a
  git-less personal setup it also carries each machine's *fast ropes*
  (Tailscale/LAN endpoints) inside the signed lease body, so a peer learns how
  to reach you fast instead of being stuck on the flaky Cloudflare rope —
  `PeerEndpointRecorder` records them against the authenticated sender (and, on
  the pull *response*, only after the responder identity is cryptographically
  verified), `MeshEndpointValidator` screens every advertised endpoint first,
  and the whole path is gated dark behind `multiMachine.meshTransport.enabled`.

### Planned handoff — "now you take it"

A graceful, ack-gated transition from the current holder to a peer. Distinct
from failover (which is involuntary).

- **`HandoffSentinel`** -- the outgoing-machine side: drives the
  `begin → ack → yield` protocol, refuses to yield unless the incoming machine
  has echoed a verified ack.
- **`HandoffReceiver`** -- the incoming-machine side: validates the begin
  request, fetches the latest live-tail, performs the ack only when its state
  is caught-up.
- **`HandoffWireTransport`** -- the point-to-point ack/yield channel between
  the two machines, symmetric on both ends.

### Live-tail streaming — "the standby is ready to take over"

The lease holder continuously pushes the recent encrypted conversation tail to
the standby, so a failover doesn't lose the last few minutes.

- **`LiveTailSource`** -- the holder-side flush producer; tracks per-topic
  cursors so flushes are monotonic and idempotent.
- **`HttpLiveTailTransport`** -- the encrypted server-to-server transport that
  carries the flushes. Redaction-before-encryption; only the lease holder
  streams.
- **`LiveTailBuffer`** -- the standby-side persisted buffer with
  sequence-dedup. What the failover replays into the new holder.

### Exactly-once message delivery — "never a dropped or doubled reply"

Ingress and egress both go through fencing-token-gated paths, so a redelivered
inbound message can't be answered twice and a mid-handoff outbound can't be
sent by both machines.

- **`MessageProcessingLedger`** -- per-inbound-message dedup ledger. The
  no-loss / no-duplicate-reply guarantee on the receiving side.
- **`FencedOutbox`** -- fencing-token-gated outbound reply path. Only the
  current lease holder's writes commit.
- **`ReplyMarkerTransport`** -- propagates the `reply_committed` marker from
  the holder to standby peers so post-failover the new holder won't re-send
  a reply the old holder already committed.
- **`PendingInboundStore` + `QueueDrainLoop`** -- durable custody for inbound
  messages the router can't deliver right now (conversation mid-move, owner
  briefly suspect), drained in order when the blockage clears, with the
  hold-for-stability policy that stops blip-induced machine swaps. Inspect via
  `GET /pool/queue`; see [Durable Inbound Message Queue](/features/durable-message-queue/)
  for the full story. Ships dark.

### Update coordination — "don't fail over onto a different version"

- **`UpdateRestartHandshake`** -- version-skew restart verification, so a
  rolling auto-update across two machines doesn't leave the lease holder on
  one version and the standby on another.

Each component above ships flag-gated until live two-machine verification
passes; see the cross-machine seamlessness spec for the full §-by-§ wiring
plan.

### Joining the pool — code-authenticated, non-interactive

An active-active pool forms its mesh automatically, so machines join without a
human confirming visual symbols. `instar pair` (run on an awake machine) mints a
short-lived, single-use pairing code and persists it via **`PairingSessionStore`**
(`.instar/machine/pairing-session.json`, 0600). `instar join <url> --code <code>`
(run on the new machine) presents that code to the awake machine's `/api/pair`
endpoint, which validates it against the stored session and — on success —
registers the joiner as **standby**, stores its public keys, and records its
reachable URL. The pairing code (carried over the TLS tunnel) is the shared
secret; it is single-use, attempt-capped, and time-limited, and a joiner can only
ever register as standby. The persisted session that `PairingSessionStore` holds
is what lets the *running server* validate a join without an interactive step.

### Knowing where a topic runs, and moving it reliably

Once conversations can live on more than one machine, two everyday questions need solid answers: *where is this topic running and why*, and *how do I move it without guessing the magic words*.

**Where + why.** `GET /pool/placement?topic=N` returns the machine currently running a topic, its nickname, the lease-holder, and the **reason**: `pinned` (you deliberately moved it), `placed` (the `SessionRouter` load-balanced it there via `MachinePoolRegistry` — not a deliberate move), or `unowned`. You can ask from any machine — a standby proxies to the lease-holder, whose `TopicPlacementPinStore` holds the authoritative pin. Internally the answer is computed by the pure `TopicPlacementDescription` helper. This means an agent never has to *infer* its placement from which host it happens to be running on.

**Reliable move.** Saying "move this to the mini" still works (parsed by `NicknameCommand` → `TransferByNickname`), and the recognizer now always includes the local machine's own nickname via `RelocationNicknameSet` — so "move it back here" can't silently fall through. When you want a move that doesn't depend on phrasing at all, `POST /pool/transfer` with `{topic, to}` (a nickname *or* a machineId) runs the same validated planner — rate-limit, online, already-there, and offline-confirmation checks — sets the pin via `TopicPlacementPinStore`, and hands the topic over. A non-holder proxies to the holder automatically.

Both endpoints sit alongside `GET /pool`, `GET /pool/machines/:id`, and `GET /session-pool/e2e-results`, and like the rest of the pool they stay inert (`503`) until the pool is enabled.

**Scheduled-job claims across the pool (WS4.3).** On a multi-machine pool the scheduler must avoid two machines running the same cron job. Claims start on a best-effort AgentBus broadcast (`JobClaimManager`) and upgrade to a durable, epoch-fenced lease over the replicated journal (`JobLeaseClaimStore`) — but the cutover engages only when the `JobLeaseCutoverGate` confirms every online peer advertises the `ws43JournalLease` capability (flag coherence). That gate is the single decision point guaranteeing the journal lease and the legacy bus broadcast are never both live for the same job set; a mixed or single-machine pool stays on the bus path unchanged. Ships dark behind `multiMachine.seamlessness.ws43JournalLease` (dry-run first, so the intended journal claims are logged before any real cutover).

### Mesh self-healing: stale-owner release + lease hand-back (U4.2 / U4.4)

Two reconcilers close the "mesh drifted into the wrong shape and nobody fixed it" class.

**Stale-owner release (U4.2, `multiMachine.sessionPool.staleOwnerRelease`, dev-gated dark, dry-run first).** When a topic's owner machine is genuinely dead or dark, its topics used to strand behind detection-only sentinels until a human demoted the machine. The `StaleOwnerReleaseEngine` — Case C of the ownership reconciler with an upgraded evidence bar — lets the serving-lease holder force-claim a provably-dead owner's topics. Every predicate is a mechanical check over authenticated state, and every ambiguity fails **closed**: observer-stamped death evidence (never the owner's self-reported clock), unreachability on *every* owner-authenticated transport, quorum, a claimant self-connectivity proof (a claimer with a broken NIC must never claim), and side-effect recency over a provably fresh replicated mirror. Claims are capped per tick, budgeted per topic on the replicated `topic-claim-annotation` record (budgets and an operator's declined-demote survive the claimer role moving with the lease), and every verdict — including every refusal — lands in `logs/stale-owner-release.jsonl`. The soak-judging telemetry is `GET /pool/stale-owner-release` (attempts, would-claims, refusals by reason, evidence classes, probe-breaker state, open episodes; 503 when dark). A claim suspends the topic's pin via the annotation (derived state — the pin record is never written), and a later operator re-pin clears it.

**Lease hand-back (U4.4, `multiMachine.leaseSelfHeal.preferredCaptainHandback`, hard-dark, action-bearing).** After a failover moves the serving lease off the preferred captain (`preferredAwakeMachineId`), nothing used to hand it back — the mesh drifted onto the sleep-prone machine until a manual captain flip. The `LeaseHandbackReconciler` (holder-side, riding the existing lease pull tick) arms after the preferred captain is continuously healthy for 10 minutes, waits for a clean boundary (no in-flight forwards, no queued inbound, ~90s ingress quiet; bounded deferral with one honest notice), then hands back **claim-before-release**: the holder mints a signed, epoch-bound, TTL-bounded, single-use consent token; the preferred captain claims at the next epoch by presenting it (`handback-offer` mesh verb, holder-only RBAC); the old holder steps down only on observing the higher epoch — a failed claim leaves the holder holding, so zero-holder states are impossible by construction. The human always wins: the operator-flip latch (`POST /pool/lease-handback/latch`, written by the flip action itself, never inferred) holds the reconciler fully inert for 24h; clearing it early (`DELETE /pool/lease-handback/latch`) is PIN-gated. Hand-backs count as churn-breaker flips, an episode cap (offers included) bounds slow ping-pong, and a post-hand-back delivery canary verifies ingress on the new holder. Status: `GET /pool/lease-handback`.

### Closing a session on another machine

The dashboard's close button (×) works on every machine's session tiles, not just the local ones. Clicking × on a remote tile sends `POST /sessions/:name/remote-close` (body `{machineId, sessionUuid}`) to *your* machine, which relays the close to the owning machine as a plain UUID-targeted local `DELETE` — the same operator-authority close a local × performs. The `machineId` is a registry lookup key only (an unknown id 404s without any network call), the Bearer token only travels to peers that pass the shared credential allowlist (`peerUrlGuard`), the relay is single-hop by construction, and the path is rate-limited to bound any kill sweep. Outcomes are delivery-honest: a peer that already closed the session reports a calm "already closed," and a relay timeout reports *outcome unknown* — never a false "closed." Both machines keep a record: the relayer appends to `logs/remote-close-audit.jsonl`, and the owner's reap-log entry carries the (untrusted, audit-only) `viaClaim`. Protected sessions are flagged in the dashboard's confirm dialog before the close is sent — informed consent, since an operator close deliberately overrides protection on either machine.

### Acknowledging another machine's attention item, durably

When the attention queue is viewed pool-wide (`GET /attention?scope=pool`), some items belong to a *different* machine. Acknowledging one of those used to be lost if the owning machine was briefly offline — the operator's intent simply evaporated and the item reappeared `OPEN` on the owner's return. `POST /attention/:id/remote-ack` (body `{machineId, status, topicId}`, ships dark behind `multiMachine.seamlessness.ws41DurableAck`) closes that gap: when the owner is reachable the ack is delivered immediately to its `PATCH /attention/:id`; when the owner is dark the intent is persisted to a durable per-machine queue (`RemoteAckStore`, `logs/remote-ack-queue.jsonl`) bound to the *authenticated operator* who performed it, and re-delivered the next time the owner is seen online (an opportunistic drain rides the pool read; `POST /attention/_remote-ack/drain` forces one, `GET /attention/_remote-ack/pending` lists the queue). The owner **revalidates at apply time**: a stale resolve against an item that has since escalated to `HIGH`/`URGENT` is rejected — the owner's current state wins — rather than silently applied. `RemoteAckStore` is idempotent on `(itemId, targetMachineId)`, so re-acking the same item just refreshes the intent. A single-machine or flag-off agent is a strict no-op (the route 503s).

### The clock under cross-machine memory (foundation)

Keeping one coherent *memory* across machines — preferences, relationships, learnings that change independently on each — needs a way to order those changes that doesn't trust any single machine's wall clock (two machines' clocks never agree perfectly, and "whoever's clock reads later wins" lets a fast clock silently clobber everyone else). The substrate for that is a **hybrid logical clock** (`HybridLogicalClock`): each change carries a tiny `{ physical, logical, node }` stamp, the merge rule guarantees cause sorts before effect, and any two distinct stamps have one definite order (machine id breaks ties) so every machine sorts the same history identically. It is monotonic across restarts and rejects a poison "far-future" stamp — measured against the *pool's* reference, not the local clock, so a merely-slow machine never wrongly rejects a peer that is legitimately a little ahead. `HybridLogicalClock` ships as an inert foundation primitive (nothing depends on it yet); the cross-machine memory-replication features build on top of it.

The next layer up is the **replicated-record envelope** (`ReplicatedRecordEnvelope`): the reusable substrate each replicated store (preferences, relationships, learnings, …) plugs into. Every replicated change is written to a per-machine journal as an envelope — a `recordKey`, the `HybridLogicalClock` stamp, a `put`/`delete` op, the author machine, and the single prior stamp the author had already seen for that key (the "last-writer-witness"; absent means *no* prior witness, so a conflict is flagged rather than silently resolved). A strict validator keeps free text, unknown fields, and path-shaped values out of the stream, exactly like the coherence journal's other kinds. Each store ships **dark and independently**: it emits its kind only when `multiMachine.stateSync.<store>.enabled` is turned on, and only ever forwards that kind to a peer that *advertises it can receive it* — so a newer kind is never silently dropped by an older machine that doesn't understand it. Nothing here changes single-machine behavior; it is pure mechanism, off by default, and a single-machine install is a no-op. The first concrete store (the cross-machine preferences pool) registers its kind onto this substrate.

### Snapshot-then-tail: how a returning machine catches up without replaying from genesis

A machine that was asleep, compacted, or simply new can't replay a peer's whole journal from the beginning — the old entries may have rotated away. The **snapshot-then-tail** path (`StoreSnapshot`) solves this: a peer that holds a store materializes the *current* state of the records **it itself authored** (a "single-origin" snapshot — origin always equals the serving machine, so a compromised peer can never smuggle a record under someone else's name), hands it over once, and the returning machine then *tails* only the new changes after it. The cutover is deliberately sequence-driven, not clock-driven: the snapshot carries a per-(origin, kind) sequence **watermark vector**, the receiver seeds its cursor to that watermark, and the existing journal's "next sequence must be contiguous" rule does all the no-gap / no-double-apply work — the hybrid logical clock is demoted to a belt-and-suspenders duplicate filter here. Deletes ride along as tombstones with a per-key high-water mark, so a stale pre-delete edit can never *resurrect* a key that was already deleted.

Because materializing a whole store can be heavy, `StoreSnapshotEngine` runs the build **off the server's event loop** in a worker thread (the same instar#1069 discipline the cartographer uses), and a built snapshot is cached. The cache (`SnapshotCache`) is a fixed-ceiling LRU ring — bounded by both a snapshot count and a byte budget, *not* scaled by pool size — with a loss counter so an eviction (just a recompute on next demand) is visible rather than silent. A flapping machine that keeps asking for the same snapshot is served the cached copy and rate-limited by a per-peer rebuild breaker (`SnapshotRebuildBreaker`), so a peer can never storm a holder into rebuilding endlessly. The pull travels over the same authenticated mesh RPC as everything else (a `state-snapshot` read/observe verb); there is no LAN broadcast, so it scales to N cloud machines. All of this ships dark with the rest of `multiMachine.stateSync` — with no store enabled, the engine has nothing to materialize and the path is a strict no-op.

## Account Follow-Me across machines

A subscription account you logged into one machine becomes usable on the others the ToS-safe way: each machine re-mints its own login (you approve once), and no login token is copied. The security primitives — `AccountCredentialShare`, `CrossMachineMandate`, `PairingEpochManager`, `AccountFollowMeGrants`, and the credential-free `SubscriptionAccountMetaReplicatedStore` metadata kind — are detailed on the [Account Follow-Me](/features/account-follow-me/) page. The detection layer (`AccountFollowMeOrchestrator`, `AccountFollowMeDetector`, `AccountFollowMeService`, `AccountFollowMeEmailGate`) notices a machine with no usable account and surfaces a one-tap consent — it never self-enrolls. All dark behind `multiMachine.accountFollowMe`.
