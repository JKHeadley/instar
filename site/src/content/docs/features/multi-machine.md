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
  sees an awake-machine demotion within seconds rather than minutes.

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

### Closing a session on another machine

The dashboard's close button (×) works on every machine's session tiles, not just the local ones. Clicking × on a remote tile sends `POST /sessions/:name/remote-close` (body `{machineId, sessionUuid}`) to *your* machine, which relays the close to the owning machine as a plain UUID-targeted local `DELETE` — the same operator-authority close a local × performs. The `machineId` is a registry lookup key only (an unknown id 404s without any network call), the Bearer token only travels to peers that pass the shared credential allowlist (`peerUrlGuard`), the relay is single-hop by construction, and the path is rate-limited to bound any kill sweep. Outcomes are delivery-honest: a peer that already closed the session reports a calm "already closed," and a relay timeout reports *outcome unknown* — never a false "closed." Both machines keep a record: the relayer appends to `logs/remote-close-audit.jsonl`, and the owner's reap-log entry carries the (untrusted, audit-only) `viaClaim`. Protected sessions are flagged in the dashboard's confirm dialog before the close is sent — informed consent, since an operator close deliberately overrides protection on either machine.

### The clock under cross-machine memory (foundation)

Keeping one coherent *memory* across machines — preferences, relationships, learnings that change independently on each — needs a way to order those changes that doesn't trust any single machine's wall clock (two machines' clocks never agree perfectly, and "whoever's clock reads later wins" lets a fast clock silently clobber everyone else). The substrate for that is a **hybrid logical clock** (`HybridLogicalClock`): each change carries a tiny `{ physical, logical, node }` stamp, the merge rule guarantees cause sorts before effect, and any two distinct stamps have one definite order (machine id breaks ties) so every machine sorts the same history identically. It is monotonic across restarts and rejects a poison "far-future" stamp — measured against the *pool's* reference, not the local clock, so a merely-slow machine never wrongly rejects a peer that is legitimately a little ahead. `HybridLogicalClock` ships as an inert foundation primitive (nothing depends on it yet); the cross-machine memory-replication features build on top of it.
