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
