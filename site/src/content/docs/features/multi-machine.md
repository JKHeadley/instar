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
